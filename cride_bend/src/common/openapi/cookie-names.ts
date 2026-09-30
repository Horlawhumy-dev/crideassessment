/**
 * Set by the auth controller, read by the Socket.IO handshake and referenced by the
 * OpenAPI security schemes: a duplicated literal writes a cookie under one name and
 * clears it under another, which logs nobody out.
 */
export const ACCESS_COOKIE = 'cride.sid';
export const REFRESH_COOKIE = 'cride.refresh';
