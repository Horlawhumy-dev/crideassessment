'use client';

import { TripHistory } from '@/features/trips/trip-history';

/** The layout's guard has already resolved the session, so the list needs nothing else. */
export default function RiderTripsPage() {
  return <TripHistory role="RIDER" />;
}
