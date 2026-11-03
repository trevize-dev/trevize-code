import { TrevizeApi, TrevizeSync } from "@t3tools/client-runtime/trevize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  dispatchLocalStorageChange,
  getLocalStorageItem,
  setLocalStorageItem,
} from "../hooks/useLocalStorage";

export const TREVIZE_SETTINGS_STORAGE_KEY = "t3code:trevize:v1";

export function defaultTrevizeBaseUrl(): string {
  return import.meta.env.VITE_TREVIZE_API_URL?.trim() || TrevizeApi.DEFAULT_TREVIZE_API_URL;
}

export function defaultTrevizeSettings(): TrevizeSync.TrevizeClientSettings {
  return TrevizeSync.defaultTrevizeClientSettings(defaultTrevizeBaseUrl());
}

function readSettings(): TrevizeSync.TrevizeClientSettings {
  try {
    return (
      getLocalStorageItem(TREVIZE_SETTINGS_STORAGE_KEY, TrevizeSync.TrevizeClientSettings) ??
      defaultTrevizeSettings()
    );
  } catch {
    return defaultTrevizeSettings();
  }
}

/** Writes the settings and re-renders every `useLocalStorage` reader of them. */
export function updateStoredTrevizeSettings(
  f: (current: TrevizeSync.TrevizeClientSettings) => TrevizeSync.TrevizeClientSettings,
): void {
  try {
    setLocalStorageItem(
      TREVIZE_SETTINGS_STORAGE_KEY,
      f(readSettings()),
      TrevizeSync.TrevizeClientSettings,
    );
    dispatchLocalStorageChange(TREVIZE_SETTINGS_STORAGE_KEY);
  } catch (error) {
    console.error("[TREVIZE] Could not save Trevize settings.", error);
  }
}

/**
 * The same local storage item the Trevize Cloud settings read through
 * `useLocalStorage`, so a sync that records managed origins re-renders them.
 */
export const layerTrevizeSettingsStore = Layer.succeed(
  TrevizeSync.TrevizeSettingsStore,
  TrevizeSync.TrevizeSettingsStore.of({
    get: Effect.sync(readSettings),
    update: Effect.fn("TrevizeSettingsStore.update")((f) =>
      Effect.sync(() => updateStoredTrevizeSettings(f)),
    ),
  }),
);
