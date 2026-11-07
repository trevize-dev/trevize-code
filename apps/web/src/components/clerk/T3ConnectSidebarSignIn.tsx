import { CircleUserIcon, LogInIcon } from "lucide-react";

import { useAuth } from "~/cloud/trevizeAccount"; // Trevize: Trevize sign-in, not Clerk
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { useT3ConnectAccountPage } from "./T3ConnectAccountPages";
import { useT3ConnectAuthPrompt } from "./useT3ConnectAuthPrompt";

export function T3ConnectSidebarSignIn() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredT3ConnectSidebarSignIn />;
}

export function T3ConnectSidebarAvatar() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredT3ConnectSidebarAvatar />;
}

// Trevize: Clerk's UserButton is replaced by a button that opens the account pages.
function ConfiguredT3ConnectSidebarAvatar() {
  const { isLoaded, isSignedIn } = useAuth();
  const accountPage = useT3ConnectAccountPage();

  if (!isLoaded || !isSignedIn || !accountPage.open) return null;
  const openAccountPage = accountPage.open;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={() => openAccountPage()}>
          <CircleUserIcon />
          <span>T3 Connect</span>
        </SidebarMenuButton>
        {accountPage.portals}
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function ConfiguredT3ConnectSidebarSignIn() {
  const { isLoaded, isSignedIn } = useAuth();
  const { openAuthPrompt } = useT3ConnectAuthPrompt();

  if (!isLoaded || isSignedIn) return null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={openAuthPrompt}>
          <LogInIcon />
          <span>Sign in to T3 Connect</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
