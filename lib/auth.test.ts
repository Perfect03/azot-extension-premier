import { afterEach, expect, test, vi } from "vitest";
import * as Azot from "azot/v2";
import extension from "../main.ts";
import { DEVICE, ROUTES } from "./constants.ts";

const login = extension.auth?.login;
const getState = extension.auth?.getState;
const logout = extension.auth?.logout;
if (!login || !getState || !logout) throw new Error("Premier authentication hooks are missing");

const activatedDevice = () => ({
  result: {
    isActivated: true,
    device: {
      accessTokenExpiredAt: new Date(Date.now() + 60_000).toISOString(),
      accessToken: "access-token",
      refreshToken: "refresh-token",
      umaTokens: { accessToken: "uma-access-token", refreshToken: "uma-refresh-token" },
      id: 123,
    },
    user: { username: "test-user" },
  },
});

afterEach(() => vi.restoreAllMocks());

test("verifies device activation, stores the session, and logs out", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ result: { activationCode: "123456" } }))
    .mockResolvedValueOnce(Response.json(activatedDevice()));
  const confirm = vi.spyOn(Azot, "confirm").mockResolvedValue(true);
  const signal = new AbortController().signal;
  localStorage.setItem("unrelated-setting", "keep");
  expect(await getState()).toMatchObject({ authenticated: false });

  await login({ method: "interactive", signal });

  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("123456"), expect.any(Object));
  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    ROUTES.smartRegister,
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify(DEVICE),
      signal,
    }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    ROUTES.smartCheck("123456"),
    expect.objectContaining({ signal }),
  );
  expect(await getState()).toEqual({ authenticated: true, user: "test-user" });
  expect(localStorage.getItem("umaAccessToken")).toBe("uma-access-token");
  expect(localStorage.getItem("deviceId")).toBe("123");

  await logout();

  expect(await getState()).toMatchObject({ authenticated: false });
  expect(localStorage.getItem("refreshToken")).toBeNull();
  expect(localStorage.getItem("username")).toBeNull();
  expect(localStorage.getItem("unrelated-setting")).toBe("keep");
});

test("checks activation again after an unactivated code", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ result: { activationCode: "111111" } }))
    .mockResolvedValueOnce(Response.json({ result: { isActivated: false } }))
    .mockResolvedValueOnce(Response.json({ result: { activationCode: "222222" } }))
    .mockResolvedValueOnce(Response.json(activatedDevice()));
  vi.spyOn(Azot, "confirm").mockResolvedValue(true);

  await login({ method: "interactive" });

  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(await getState()).toMatchObject({ authenticated: true });
});

test("stops pairing when the dialog is cancelled", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ result: { activationCode: "123456" } }));
  vi.spyOn(Azot, "confirm").mockResolvedValue(false);

  await expect(login({ method: "interactive" })).rejects.toMatchObject({ name: "AbortError" });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(await getState()).toMatchObject({ authenticated: false });
});

test("aborts a pending pairing dialog without checking or storing activation", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ result: { activationCode: "123456" } }));
  const controller = new AbortController();
  vi.spyOn(Azot, "confirm").mockImplementation(() => {
    controller.abort();
    return new Promise(() => {});
  });

  await expect(login({ method: "interactive", signal: controller.signal })).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(await getState()).toMatchObject({ authenticated: false });
});

test.each<Azot.AuthRequest>([
  { method: "token", token: "provided-token" },
  { method: "cookies" },
  { method: "password", username: "provided-user", password: "provided-password" },
])("rejects unsupported $method login without interacting", async (request) => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  const confirm = vi.spyOn(Azot, "confirm");

  await expect(login(request)).rejects.toThrow("interactive device login only");

  expect(fetchMock).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
});

test.each(["2020-01-01T00:00:00Z", "invalid-date"])(
  "rejects an expired or invalid session (%s)",
  async (expiry) => {
    localStorage.setItem("accessToken", "access-token");
    localStorage.setItem("umaAccessToken", "uma-access-token");
    localStorage.setItem("expiresAt", expiry);

    expect(await getState()).toMatchObject({ authenticated: false });
  },
);

test("stops after ten unactivated pairing attempts", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url) =>
      Response.json(
        String(url) === ROUTES.smartRegister
          ? { result: { activationCode: "123456" } }
          : { result: { isActivated: false } },
      ),
    );
  vi.spyOn(Azot, "confirm").mockResolvedValue(true);

  await expect(login({ method: "interactive" })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });

  expect(fetchMock).toHaveBeenCalledTimes(20);
  expect(await getState()).toMatchObject({ authenticated: false });
});
