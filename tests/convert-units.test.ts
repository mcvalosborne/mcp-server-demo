import { describe, expect, it } from "vitest";
import { ConversionError, convertUnits } from "../src/tools/convert-units.js";

describe("convertUnits", () => {
  it("converts length", () => {
    expect(convertUnits(1, "km", "m")).toMatchObject({ from: "km", to: "m", result: 1000 });
    expect(convertUnits(1, "km", "mi").result).toBeCloseTo(0.621371192237, 8);
  });

  it("converts weight, including names", () => {
    expect(convertUnits(1, "pounds", "oz")).toMatchObject({ from: "lb", to: "oz", result: 16 });
    expect(convertUnits(1000, "g", "kg").result).toBe(1);
  });

  it("converts temperature", () => {
    expect(convertUnits(0, "C", "F").result).toBe(32);
    expect(convertUnits(100, "celsius", "F").result).toBe(212);
    expect(convertUnits(-40, "F", "C").result).toBe(-40);
    expect(convertUnits(273.15, "K", "°C").result).toBe(0);
  });

  it("returns the same value when the units match", () => {
    expect(convertUnits(5, "m", "meters").result).toBe(5);
  });

  it("rejects mixed categories and unknown units", () => {
    expect(() => convertUnits(1, "km", "kg")).toThrow(ConversionError);
    expect(() => convertUnits(1, "km", "kg")).toThrow(/length.*weight/);
    expect(() => convertUnits(1, "stone", "kg")).toThrow(/Unknown unit "stone"/);
  });

  it("rejects a non-finite value", () => {
    expect(() => convertUnits(Number.POSITIVE_INFINITY, "m", "ft")).toThrow(/finite/);
  });
});
