/**
 * Canonical virtual user used by request-level tests that are not exercising
 * authentication itself. D1Mock exposes this row only to the active-user auth
 * lookup, so it does not pollute user-management/list assertions.
 */
export const TEST_USER_ID = "test-principal";
export const TEST_USERNAME = "test-principal";
export const TEST_USER_SECRET = "test-principal-secret";
export const TEST_USER_API_KEY = `slm_${TEST_USER_ID}.${TEST_USER_SECRET}`;
export const TEST_USER_AUTH_HASH = "fd58c593543ea4230f8ad9dc8f929f54602b0fe2921f9ce03d74c4f45d2d7755";
