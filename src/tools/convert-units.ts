import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const LENGTH_TO_METRES: Record<string, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  km: 1000,
  in: 0.0254,
  ft: 0.3048,
  yd: 0.9144,
  mi: 1609.344,
};

const WEIGHT_TO_GRAMS: Record<string, number> = {
  mg: 0.001,
  g: 1,
  kg: 1000,
  oz: 28.349523125,
  lb: 453.59237,
};

const TEMPERATURE = new Set(["C", "F", "K"]);

const ALIASES: Record<string, string> = {
  millimeter: "mm",
  millimeters: "mm",
  millimetre: "mm",
  millimetres: "mm",
  centimeter: "cm",
  centimeters: "cm",
  centimetre: "cm",
  centimetres: "cm",
  meter: "m",
  meters: "m",
  metre: "m",
  metres: "m",
  kilometer: "km",
  kilometers: "km",
  kilometre: "km",
  kilometres: "km",
  inch: "in",
  inches: "in",
  foot: "ft",
  feet: "ft",
  yard: "yd",
  yards: "yd",
  mile: "mi",
  miles: "mi",
  milligram: "mg",
  milligrams: "mg",
  gram: "g",
  grams: "g",
  kilogram: "kg",
  kilograms: "kg",
  ounce: "oz",
  ounces: "oz",
  pound: "lb",
  pounds: "lb",
  lbs: "lb",
  celsius: "C",
  centigrade: "C",
  fahrenheit: "F",
  kelvin: "K",
};

export const convertUnitsInput = z.object({
  value: z.number().finite().describe("Amount to convert."),
  from: z.string().min(1).describe("Source unit, for example km, lb, or C."),
  to: z.string().min(1).describe("Target unit, for example mi, kg, or F."),
});

export interface Conversion {
  value: number;
  from: string;
  to: string;
  result: number;
}

type UnitKind = "length" | "weight" | "temperature";

interface ResolvedUnit {
  symbol: string;
  kind: UnitKind;
  /** Multiply a value in this unit by `factor` to reach metres or grams. Unused for temperature. */
  factor: number;
}

export class ConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversionError";
  }
}

export function supportedUnits(): string {
  const length = Object.keys(LENGTH_TO_METRES).join(", ");
  const weight = Object.keys(WEIGHT_TO_GRAMS).join(", ");
  return `Length: ${length}. Weight: ${weight}. Temperature: C, F, K.`;
}

export function convertUnits(value: number, from: string, to: string): Conversion {
  if (!Number.isFinite(value)) {
    throw new ConversionError("value must be a finite number.");
  }

  const source = resolveUnit(from);
  const target = resolveUnit(to);
  if (source.kind !== target.kind) {
    throw new ConversionError(
      `Cannot convert ${source.symbol} (${source.kind}) to ${target.symbol} (${target.kind}).`,
    );
  }

  const result =
    source.kind === "temperature"
      ? fromCelsius(toCelsius(value, source.symbol), target.symbol)
      : (value * source.factor) / target.factor;

  return {
    value,
    from: source.symbol,
    to: target.symbol,
    result: round(result),
  };
}

export function registerConvertUnits(server: McpServer): void {
  server.registerTool(
    "convert_units",
    {
      title: "Convert units",
      description: `Convert a number between units in the same category. ${supportedUnits()} Names such as meter, pound, and celsius are accepted. Units from different categories cannot be converted.`,
      inputSchema: convertUnitsInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ value, from, to }) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(convertUnits(value, from, to), null, 2) }] };
      } catch (error) {
        const message = error instanceof ConversionError ? error.message : "Conversion failed.";
        return { content: [{ type: "text", text: message }], isError: true };
      }
    },
  );
}

function resolveUnit(input: string): ResolvedUnit {
  const key = input
    .trim()
    .toLowerCase()
    .replace(/°/g, "")
    .replace(/\s+/g, "")
    .replace(/^(degrees|degree)/, "");

  const symbol = ALIASES[key] ?? (key === "c" || key === "f" || key === "k" ? key.toUpperCase() : key);
  const length = LENGTH_TO_METRES[symbol];
  if (length !== undefined) return { symbol, kind: "length", factor: length };
  const weight = WEIGHT_TO_GRAMS[symbol];
  if (weight !== undefined) return { symbol, kind: "weight", factor: weight };
  if (TEMPERATURE.has(symbol)) return { symbol, kind: "temperature", factor: 1 };
  throw new ConversionError(`Unknown unit "${input.trim()}". ${supportedUnits()}`);
}

function toCelsius(value: number, unit: string): number {
  switch (unit) {
    case "C":
      return value;
    case "F":
      return ((value - 32) * 5) / 9;
    case "K":
      return value - 273.15;
    default:
      throw new ConversionError(`Unknown unit "${unit}".`);
  }
}

function fromCelsius(celsius: number, unit: string): number {
  switch (unit) {
    case "C":
      return celsius;
    case "F":
      return (celsius * 9) / 5 + 32;
    case "K":
      return celsius + 273.15;
    default:
      throw new ConversionError(`Unknown unit "${unit}".`);
  }
}

function round(value: number): number {
  return Number(value.toPrecision(12));
}
