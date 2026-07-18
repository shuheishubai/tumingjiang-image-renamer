import { readFile } from "node:fs/promises";

const [baseUrl, deliveryFile] = process.argv.slice(2);
if (!baseUrl || !deliveryFile) {
  throw new Error("Usage: node verify-production.mjs <base-url> <owner-key-delivery-file>");
}

const delivery = await readFile(deliveryFile, "utf8");
const ownerKey =
  delivery.match(/管理员密钥：([^\r\n]+)/)?.[1]?.trim() ||
  delivery.match(/TJ-OWNER-[A-Za-z0-9_-]+/)?.[0];
if (!ownerKey) {
  throw new Error("Owner key not found in delivery file.");
}

const request = (path, init = {}) =>
  fetch(new URL(path, baseUrl), {
    redirect: "manual",
    ...init,
  });

const anonymous = await request("/api/access/status");
const anonymousBody = await anonymous.json();
if (anonymous.status !== 200 || anonymousBody.authenticated) {
  throw new Error("Anonymous access check failed.");
}

const login = await request("/api/access/login", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    origin: baseUrl,
  },
  body: JSON.stringify({ key: ownerKey }),
});
if (login.status !== 200) {
  throw new Error(`Owner login failed with HTTP ${login.status}.`);
}

const setCookie = login.headers.get("set-cookie") ?? "";
for (const flag of ["Secure", "HttpOnly", "SameSite=Strict"]) {
  if (!setCookie.includes(flag)) {
    throw new Error(`Session cookie is missing ${flag}.`);
  }
}
const cookie = setCookie.split(";", 1)[0];

const authenticated = await request("/api/access/status", {
  headers: { cookie },
});
const authenticatedBody = await authenticated.json();
if (
  authenticated.status !== 200 ||
  !authenticatedBody.authenticated ||
  authenticatedBody.role !== "owner"
) {
  throw new Error("Owner authorization check failed.");
}

for (const path of ["/", "/access/manage.html"]) {
  const page = await request(path, { headers: { cookie } });
  if (page.status !== 200) {
    throw new Error(`Protected page ${path} returned HTTP ${page.status}.`);
  }
}

const logout = await request("/api/access/logout", {
  method: "POST",
  headers: { cookie, origin: baseUrl },
});
if (logout.status !== 200) {
  throw new Error(`Logout failed with HTTP ${logout.status}.`);
}
const clearedCookieHeader = logout.headers.get("set-cookie") ?? "";
if (!clearedCookieHeader.includes("Max-Age=0")) {
  throw new Error("Logout did not clear the session cookie.");
}
const clearedCookie = clearedCookieHeader.split(";", 1)[0];

const revoked = await request("/api/access/status", {
  headers: { cookie: clearedCookie },
});
const revokedBody = await revoked.json();
if (revoked.status !== 200 || revokedBody.authenticated) {
  throw new Error("Logged-out session was not revoked.");
}

console.log(
  "Production authentication verified: anonymous blocked, owner accepted, secure session set, management authorized, logout cleared.",
);
