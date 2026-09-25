import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(secret: string, body: string, signature = "") {
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("hex"));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
