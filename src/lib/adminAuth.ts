let adminToken = "";

export function getAdminToken(): string {
  return adminToken;
}

export function setAdminToken(token: string): void {
  adminToken = token;
}

export function clearAdminToken(): void {
  adminToken = "";
}
