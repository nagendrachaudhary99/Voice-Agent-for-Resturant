import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Papa from "papaparse";

import { db } from "../src/client.js";

function usage() {
  console.log(
    [
      "Usage:",
      "  pnpm --filter db menu:import -- <path/to/menu.csv>",
      "",
      "CSV columns:",
      "  code,name,category,description,price_cents,is_available,prep_time_min",
      "",
      "Example:",
      "  pnpm --filter db menu:import -- raw/menu/menu.csv",
    ].join("\n")
  );
}

function toBool(v: unknown, defaultValue: boolean) {
  if (v === undefined || v === null || v === "") return defaultValue;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(s)) return true;
  if (["false", "0", "no", "n"].includes(s)) return false;
  return defaultValue;
}

function toInt(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

type Row = {
  code: string;
  name: string;
  category?: string;
  description?: string;
  price_cents: string | number;
  is_available?: string | boolean;
  prep_time_min?: string | number;
};

async function main() {
  const rawArg = process.argv[2];
  // When invoked via `pnpm ... -- <file>`, pnpm forwards a literal `--` argument.
  const fileArg = rawArg === "--" ? process.argv[3] : rawArg;
  if (!fileArg || fileArg === "--help" || fileArg === "-h") {
    usage();
    process.exit(fileArg ? 0 : 1);
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..", "..", "..");

  const candidatePaths: string[] = [];
  if (path.isAbsolute(fileArg)) {
    candidatePaths.push(fileArg);
  } else {
    candidatePaths.push(path.resolve(process.cwd(), fileArg));
    candidatePaths.push(path.resolve(repoRoot, fileArg));
  }

  let filePath: string | null = null;
  for (const p of candidatePaths) {
    try {
      await stat(p);
      filePath = p;
      break;
    } catch {
      // keep trying
    }
  }

  if (!filePath) {
    console.error(
      `Menu CSV not found. Tried:\n${candidatePaths.map((p) => `- ${p}`).join("\n")}`
    );
    process.exit(1);
  }
  const csv = await readFile(filePath, "utf8");

  const parsed = Papa.parse<Row>(csv, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors.length) {
    console.error(parsed.errors);
    process.exit(1);
  }

  const rows = (parsed.data ?? []).filter((r) => r && r.code && r.name);
  if (rows.length === 0) {
    console.error("No valid rows found. Check that code/name columns exist.");
    process.exit(1);
  }

  let upserted = 0;
  for (const r of rows) {
    const priceCents = toInt(r.price_cents);
    if (priceCents === null) {
      console.warn(`Skipping ${r.code}: invalid price_cents`);
      continue;
    }

    await db.menuItem.upsert({
      where: { code: String(r.code).trim() },
      create: {
        code: String(r.code).trim(),
        name: String(r.name).trim(),
        category: r.category ? String(r.category).trim() : null,
        description: r.description ? String(r.description).trim() : null,
        priceCents,
        isAvailable: toBool(r.is_available, true),
        prepTimeMin: toInt(r.prep_time_min),
      },
      update: {
        name: String(r.name).trim(),
        category: r.category ? String(r.category).trim() : null,
        description: r.description ? String(r.description).trim() : null,
        priceCents,
        isAvailable: toBool(r.is_available, true),
        prepTimeMin: toInt(r.prep_time_min),
      },
    });
    upserted += 1;
  }

  console.log(`Upserted ${upserted} menu items.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

