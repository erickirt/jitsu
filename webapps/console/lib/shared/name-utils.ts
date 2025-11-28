import { publicEmailDomains } from "./email-domains";

function ensureLength(res): string {
  return res.length < 5 ? res + "project" : res;
}

export function pickSlug(email: string, name: string): string {
  if (name) {
    //remove 's workspace from name
    name = name.replace(/'s workspace$/g, "");
    return ensureLength(name.toLowerCase().replace(/[^a-z0-9]/g, ""));
  }
  const [username, domain] = email.split("@");
  if (!publicEmailDomains.includes(domain.toLowerCase())) {
    const [company] = domain.split(".");
    return ensureLength(company.toLowerCase());
  }
  return ensureLength(username.replace(/[^a-z0-9]/g, ""));
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function pickWorkspaceName(email: string, name: string) {
  if (!email) {
    return `${name}'s workspace`;
  }
  const [username, domain] = email.split("@");
  if (publicEmailDomains.includes((domain ?? "").toLowerCase())) {
    return `${username}'s workspace`;
  } else {
    const [company, ...rest] = domain.split(".");
    return `${capitalize(company)}'s workspace`;
  }
}
