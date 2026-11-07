// Trevize: Clerk's profile modal hosted these pages. T3 Connect signs in with a
// Trevize account, so they open in our own dialog instead.
import { MessageSquareIcon, ServerIcon, SmartphoneIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { useAuth } from "~/cloud/trevizeAccount";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { MobileClientsUserProfilePage } from "./MobileClientsUserProfilePage";
import { T3ChatUserProfilePage } from "./T3ChatUserProfilePage";
import { T3ConnectUserProfilePage } from "./T3ConnectUserProfilePage";

const T3_CONNECT_ACCOUNT_PAGES = [
  {
    label: "Mobile clients",
    url: "mobile-clients",
    icon: <SmartphoneIcon className="size-4" />,
    content: <MobileClientsUserProfilePage />,
  },
  {
    label: "T3 Connect",
    url: "t3-connect",
    icon: <ServerIcon className="size-4" />,
    content: <T3ConnectUserProfilePage />,
  },
  {
    label: "T3 Chat",
    url: "t3-chat",
    icon: <MessageSquareIcon className="size-4" />,
    content: <T3ChatUserProfilePage />,
  },
] as const;

export type T3ConnectAccountPageUrl = (typeof T3_CONNECT_ACCOUNT_PAGES)[number]["url"];

/** Opens the account pages in a dialog; render `portals` wherever the hook is used. */
export function useT3ConnectAccountPage(): {
  readonly open: ((page?: T3ConnectAccountPageUrl) => void) | null;
  readonly portals: ReactNode;
} {
  const { isSignedIn } = useAuth();
  const [page, setPage] = useState<T3ConnectAccountPageUrl | null>(null);

  const open = (next: T3ConnectAccountPageUrl = "t3-connect") => setPage(next);

  const current = T3_CONNECT_ACCOUNT_PAGES.find((entry) => entry.url === page);
  const portals = current ? (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) setPage(null);
      }}
    >
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>T3 Connect</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <ToggleGroup
              aria-label="Account page"
              className="w-full *:flex-1"
              value={[current.url]}
              onValueChange={(next) => {
                const selected = T3_CONNECT_ACCOUNT_PAGES.find((entry) => entry.url === next[0]);
                if (selected) setPage(selected.url);
              }}
            >
              {T3_CONNECT_ACCOUNT_PAGES.map((entry) => (
                <Toggle key={entry.url} value={entry.url}>
                  {entry.icon}
                  {entry.label}
                </Toggle>
              ))}
            </ToggleGroup>
            {current.content}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  ) : null;

  return { open: isSignedIn ? open : null, portals };
}
