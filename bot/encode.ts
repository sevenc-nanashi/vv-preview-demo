import fs from "node:fs/promises";
import { fromByteArray } from "base64-js";

const dotEnv = await fs.readFile(".env", "utf8");
await fs.writeFile(
  ".env.base64",
  fromByteArray(new TextEncoder().encode(dotEnv)),
);

const privateKey = await fs.readFile("./private-key.pem", "utf8");
await fs.writeFile(
  "./private-key.pem.base64",
  fromByteArray(new TextEncoder().encode(privateKey)),
);

console.log("Done.");
const createSha256Hash = async (data: string) => {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(data),
  );
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const dotEnvHash = await createSha256Hash(dotEnv);
console.log(`${dotEnvHash}  .env`);
console.log(" -> ENV_BASE64")

const privateKeyHash = await createSha256Hash(privateKey);
console.log(`${privateKeyHash}  private-key.pem`);
console.log(" -> PRIVATE_KEY_BASE64")
