// Phone validation at our boundary: accept common separators, require E.164 (+ country code, 8-15 digits).
// The Verify API validates again (invalid_number, country rules); this just catches typos early.
export function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  const compact = input.trim().replace(/[\s().-]/g, '').replace(/^00/, '+');
  return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : null;
}

// Show only the last digits in pages and logs.
export function maskPhone(phone) {
  return phone.length > 4 ? phone.slice(0, 3) + '•'.repeat(phone.length - 5) + phone.slice(-2) : phone;
}
