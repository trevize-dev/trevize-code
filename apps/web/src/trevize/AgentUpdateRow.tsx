import { useAtomValue } from "@effect/atom-react";
import { TrevizeAgentUpdates } from "@t3tools/client-runtime/trevize";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  ExternalLinkIcon,
  MessageCircleQuestionMarkIcon,
  MessageSquareIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { WorkLogDetails, WorkLogRow } from "~/components/chat/WorkLog";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { InlineButton } from "~/components/ui/button";
import * as Trevize from "./commands";
import { useOpenMyTask } from "./MyTasks";

type Update = TrevizeAgentUpdates.TrevizeAgentUpdate;

const EVENT_ICONS: Record<TrevizeAgentUpdates.TrevizeAgentUpdateEvent, ReactNode> = {
  completed: <CircleCheckIcon className="size-4 text-success" />,
  failed: <CircleAlertIcon className="size-4 text-destructive" />,
  waiting: <MessageCircleQuestionMarkIcon className="size-4 text-warning" />,
  pull_request: <PullRequestGlyph.pullRequest className="size-4 text-muted-foreground" />,
  message: <MessageSquareIcon className="size-4 text-muted-foreground" />,
};

/**
 * Opens the other party of an agent update: its tab when it belongs to the
 * space on screen, else its thread the way My tasks opens one.
 */
function useOpenAgentUpdateThread() {
  const navigate = useNavigate();
  const sync = useAtomValue(Trevize.syncStateValueAtom);
  const activeSpaceId = useParams({
    strict: false,
    select: (params) => ("spaceId" in params ? params.spaceId : undefined),
  });
  const { open } = useOpenMyTask();
  return (thread: Update["thread"]) => {
    const target = TrevizeAgentUpdates.trevizeAgentUpdateTarget({
      thread,
      activeSpace: sync.spaces.find((space) => space.id === activeSpaceId) ?? null,
      environments: sync.environments,
    });
    if (target._tag === "SpaceTab") {
      void navigate({
        to: "/spaces/$spaceId",
        params: { spaceId: target.spaceId },
        search: target.tab === null ? {} : { tab: target.tab },
      });
      return;
    }
    void open(target.thread);
  };
}

/**
 * A message Trevize relayed between a space's orchestrator and one of its
 * agents, drawn as a timeline notification instead of a user bubble. `body`
 * follows the row; an orchestrator's message to an agent keeps its text there.
 */
export function TrevizeAgentUpdateRow(props: {
  readonly update: Update;
  readonly trailing: ReactNode;
  readonly body: ReactNode;
}) {
  const { update } = props;
  const openThread = useOpenAgentUpdateThread();
  const [expanded, setExpanded] = useState(false);
  const toAgent = update.direction === "to-agent";
  const detail = toAgent ? null : update.detail;
  const name = (
    <InlineButton
      onClick={(event) => {
        event.stopPropagation();
        openThread(update.thread);
      }}
      aria-label={`Open ${update.title}`}
    >
      {update.title}
    </InlineButton>
  );
  return (
    <div data-trevize-agent-update={update.event}>
      <WorkLogRow
        wrapLabel
        icon={toAgent ? EVENT_ICONS.message : EVENT_ICONS[update.event]}
        aria-expanded={detail === null ? undefined : expanded}
        onClick={detail === null ? undefined : () => setExpanded((value) => !value)}
        label={
          <span className="text-sm">
            {toAgent ? <>Message from {name}</> : <>{name} </>}
            {toAgent ? null : <span>{update.summary}</span>}
            {update.pullRequestUrl ? (
              <>
                {" "}
                <InlineButton
                  tone="muted"
                  onClick={(event) => event.stopPropagation()}
                  render={
                    <a href={update.pullRequestUrl} target="_blank" rel="noopener noreferrer" />
                  }
                >
                  Pull request
                  <ExternalLinkIcon className="size-3" />
                </InlineButton>
              </>
            ) : null}
          </span>
        }
        trailing={props.trailing}
      >
        {detail !== null && expanded ? (
          <WorkLogDetails>
            <ChatMarkdown text={detail} cwd={undefined} lineBreaks parseRawHtml={false} />
          </WorkLogDetails>
        ) : null}
      </WorkLogRow>
      {props.body ? <div className="ms-7 pt-1">{props.body}</div> : null}
    </div>
  );
}
