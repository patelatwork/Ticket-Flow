/** Mirrors the API DTOs (apps/api/src/modules/*). Money is integer paise; dates are ISO UTC. */
export type Role = 'attendee' | 'organizer' | 'admin';
export type SeatState = 'AVAILABLE' | 'HELD' | 'SOLD';
export type BookingStatus = 'HELD' | 'PAID' | 'EXPIRED' | 'CANCELLED' | 'REFUNDED';
export type PaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUND_PENDING' | 'REFUNDED';

export interface User {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
}

export interface EventSummary {
  id: string;
  organizerId: string;
  title: string;
  description: string;
  venue: string;
  startsAt: string;
  status: 'DRAFT' | 'PUBLISHED' | 'CANCELLED';
}

export interface Seat {
  id: string;
  label: string;
  tier: string;
  pricePaise: number;
  state: SeatState;
}

export interface SeatMap {
  event: EventSummary;
  seats: Seat[];
}

export interface Booking {
  id: string;
  eventId: string;
  eventTitle: string;
  eventStartsAt: string;
  status: BookingStatus;
  holdExpiresAt: string;
  totalPaise: number;
  createdAt: string;
  seats: { id: string; label: string; tier: string; pricePaise: number }[];
}

export interface Payment {
  id: string;
  bookingId: string;
  provider: string;
  status: PaymentStatus;
  amountPaise: number;
  providerOrderId: string | null;
  checkout: Record<string, unknown> | null;
  refundReason: string | null;
}

export interface Ticket {
  id: string;
  bookingId: string;
  eventTitle: string;
  venue: string;
  startsAt: string;
  seatLabel: string;
  tier: string;
  ready: boolean;
  usedAt: string | null;
  valid: boolean;
}

export interface EventSales {
  eventId: string;
  title: string;
  startsAt: string;
  status: string;
  totalSeats: number;
  seatsSold: number;
  seatsHeld: number;
  bookingsPaid: number;
  grossPaise: number;
  refundedPaise: number;
}

export interface DailyReport {
  reportDate: string;
  bookingsPaid: number;
  ticketsSold: number;
  grossPaise: number;
  refundedPaise: number;
}

/** Live update messages from GET /events/:id/seats/stream. */
export type SeatStreamMessage =
  | { type: 'seats'; eventId: string; seats: { id: string; state: SeatState }[]; at: string }
  | { type: 'refresh'; eventId: string; at: string };
