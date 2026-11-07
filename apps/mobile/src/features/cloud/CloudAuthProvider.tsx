import type { ReactNode } from "react";

import { cloudAccountService, deactivateCloudRelayAccount } from "./cloudAccountService";
import { hasCloudPublicConfig } from "./publicConfig";
import { trevizeAccountSource } from "./trevizeAccount";

// Trevize: T3 Connect signs in with a Trevize account, so there is no Clerk
// provider; the service observes the Trevize account for the app's lifetime.
// Build-time constant: false when this build has no relay URL.
const cloudEnabled = hasCloudPublicConfig();

if (cloudEnabled) {
  cloudAccountService.attach(trevizeAccountSource);
} else {
  // Without cloud config no account can ever activate, so drop anything a
  // previous build with cloud enabled left registered.
  deactivateCloudRelayAccount();
}

export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  return props.children;
}
