// k6: sustained booking + payment flow (hold -> pay -> webhook -> PAID).
//
//   npm run seed:loadtest -- --seats 20000 --users 2000 --per-row 100 --out ../../load-tests/fixtures/flow.json
//   # API/worker with MOCK_PAYMENT_WEBHOOK_DELAY_MS=500 so the mock gateway settles quickly
//   k6 run -e BASE_URL=http://localhost:3000 -e RATE=30 -e DURATION=3m load-tests/booking-flow.js
//
// Measures: hold latency, pay latency, and end-to-end time until the booking is PAID
// (includes the outbox, the mock gateway's delayed webhook and its signature check).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const fixtures = JSON.parse(open('./fixtures/flow.json'));
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const RATE = Number(__ENV.RATE || 30);
const DURATION = __ENV.DURATION || '3m';

const paidLatency = new Trend('time_to_paid', true);
const paid = new Counter('bookings_paid');
const gaveUp = new Counter('bookings_not_paid_in_time');

http.setResponseCallback(http.expectedStatuses(200, 201, 409));

export const options = {
  scenarios: {
    flow: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: RATE * 4,
      maxVUs: RATE * 20,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:POST /bookings}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:POST /bookings/:id/pay}': ['p(95)<500'],
    time_to_paid: ['p(95)<5000'],
  },
};

function headers(token, extra) {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...extra };
}

export default function () {
  const iter = exec.scenario.iterationInTest;
  const token = fixtures.tokens[iter % fixtures.tokens.length];

  // Hold one seat; on 409 try another (a few times).
  let booking;
  for (let attempt = 0; attempt < 3 && !booking; attempt++) {
    const seatId = fixtures.seatIds[Math.floor(Math.random() * fixtures.seatIds.length)];
    const res = http.post(`${BASE_URL}/bookings`, JSON.stringify({ eventId: fixtures.eventId, seatIds: [seatId] }), {
      headers: headers(token, { 'idempotency-key': `k6-flow-${fixtures.run}-${iter}-${attempt}` }),
      tags: { name: 'POST /bookings' },
    });
    check(res, { 'hold: 201 or 409': (r) => r.status === 201 || r.status === 409 });
    if (res.status === 201) booking = res.json('booking');
  }
  if (!booking) return;

  const start = Date.now();
  const pay = http.post(`${BASE_URL}/bookings/${booking.id}/pay`, null, { headers: headers(token), tags: { name: 'POST /bookings/:id/pay' } });
  check(pay, { 'pay: 201': (r) => r.status === 201 });

  // Poll until the webhook has been applied.
  for (let i = 0; i < 40; i++) {
    sleep(0.25);
    const res = http.get(`${BASE_URL}/bookings/${booking.id}`, { headers: headers(token), tags: { name: 'GET /bookings/:id' } });
    if (res.status === 200 && res.json('booking.status') === 'PAID') {
      paidLatency.add(Date.now() - start);
      paid.add(1);
      return;
    }
  }
  gaveUp.add(1);
}
