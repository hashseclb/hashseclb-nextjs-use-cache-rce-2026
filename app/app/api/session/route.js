import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

// Lab affordance: toggles the operator cookie so you can see the console the
// way a real operator would.
//
//   /api/session?operator=1   -> operator
//   /api/session?operator=0   -> anonymous
export async function GET(request) {
  const url = new URL(request.url);
  const on = url.searchParams.get('operator') === '1';

  (await cookies()).set('operator', on ? '1' : '', { path: '/', httpOnly: true });

  return NextResponse.json({ operator: on });
}
