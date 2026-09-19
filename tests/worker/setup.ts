import { afterAll, afterEach, beforeAll } from "vitest";
import { network } from "./network.ts";

beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());
