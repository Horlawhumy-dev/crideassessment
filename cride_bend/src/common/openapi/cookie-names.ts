/**
 * Shared by the auth controller, the Socket.IO handshake and the OpenAPI security
 * schemes: a duplicated literal writes a cookie under one name and clears it under another.
 */
export const ACCESS_COOKIE = 'cride.sid';
export const REFRESH_COOKIE = 'cride.refresh';
