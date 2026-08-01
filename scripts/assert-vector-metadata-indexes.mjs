import { readFileSync } from "node:fs";

function collect(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  const normalized = new Map(
    Object.entries(value).map(([key, item]) => [key.replaceAll("_", "").toLowerCase(), item]),
  );
  const property = normalized.get("propertyname") ?? normalized.get("property");
  const type = normalized.get("indextype") ?? normalized.get("type");
  if (typeof property === "string" && typeof type === "string") {
    found.push({ property: property.toLowerCase(), type: type.toLowerCase() });
  }
  for (const item of Object.values(value)) collect(item, found);
  return found;
}

let parsed;
try {
  parsed = JSON.parse(readFileSync(0, "utf8"));
} catch {
  console.error("VECTOR_METADATA_INDEXES_INVALID:json_invalid");
  process.exit(1);
}

const indexes = collect(parsed);
const failures = [];
for (const [property, type] of [["owner_user_id", "string"], ["is_private", "boolean"]]) {
  const matches = indexes.filter(index => index.property === property);
  if (!matches.length) failures.push(`${property}_missing`);
  else if (!matches.some(index => index.type === type)) failures.push(`${property}_type`);
}

if (failures.length) {
  console.error(`VECTOR_METADATA_INDEXES_INVALID:${failures.join(",")}`);
  process.exit(1);
}
console.log("VECTOR_METADATA_INDEXES_OK");
