/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    unoptimized: true,
  },
  // The WebSocket handshake is a cross-origin request to the API and is
  // authenticated by the httpOnly `cride.sid` cookie, so it cannot be proxied
  // through Next. Exposing the API origin to the browser is therefore required,
  // not optional — see lib/realtime/socket.ts.
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
  },
}

export default nextConfig
