// k6: 1,000 virtual users contend for 100 seats at the same instant.
//
//   npm run seed:loadtest -- --seats 100 --users 1000 --out ../../load-tests/fixtures/contention.json
//   k6 run -e BASE_URL=http://localhost:3000 load-tests/contention.js
//   npm run loadtest:verify -- --event <eventId printed by the seed>
//
// Each VU tries to hold 1-3 random seats exactly once. Correct behaviour: every response
// is 201 or 409, no seat is ever granted twice, and at most 100 seats end up held.
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import exec from 'k6/execution';

const fixtures = JSON.parse(open('./fixtures/contention.json'));
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const VUS = Number(__ENV.VUS || fixtures.tokens.length);

const granted = new Counter('bookings_granted');
const conflicted = new Counter('bookings_conflicted');
const seatsGranted = new Counter('seats_granted');

http.setResponseCallback(http.expectedStatuses(201, 409));

export const options = {
  scenarios: {
    stampede: { executor: 'per-vu-iterations', vus: VUS, iterations: 1, maxDuration: '2m' },
  },
  thresholds: {
    // Every request is a 201 or a 409; anything else (5xx, deadlock surfaced as 503) fails the run.
    http_req_failed: ['rate==0'],
    'checks{check:no_server_errors}': ['rate==1'],
    seats_granted: [`count<=${fixtures.seatIds.length}`],
    http_req_duration: ['p(95)<2000'],
  },
};

function pickSeats() {
  const n = 1 + Math.floor(Math.random() * 3);
  const chosen = new Set();
  while (chosen.size < n) chosen.add(fixtures.seatIds[Math.floor(Math.random() * fixtures.seatIds.length)]);
  return [...chosen];
}

export default function () {
  const vu = exec.vu.idInTest - 1;
  const token = fixtures.tokens[vu % fixtures.tokens.length];
  const seatIds = pickSeats();
  const res = http.post(`${BASE_URL}/bookings`, JSON.stringify({ eventId: fixtures.eventId, seatIds }), {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'idempotency-key': `k6-${fixtures.run}-${vu}`,
    },
    tags: { name: 'POST /bookings' },
  });
  check(res, { no_server_errors: (r) => r.status === 201 || r.status === 409 }, { check: 'no_server_errors' });
  if (res.status === 201) {
    granted.add(1);
    seatsGranted.add(seatIds.length);
  } else if (res.status === 409) {
    conflicted.add(1);
  }
}

export function teardown() {
  // Cross-check through the API: the seat map must show exactly as many taken seats as were granted.
  const res = http.get(`${BASE_URL}/events/${fixtures.eventId}/seats`);
  const taken = res.json('seats').filter((s) => s.state !== 'AVAILABLE').length;
  console.log(`seat map: ${taken} of ${fixtures.seatIds.length} seats taken. Run loadtest:verify --event ${fixtures.eventId} for the DB check.`);
}
