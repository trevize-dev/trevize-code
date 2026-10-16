import { TrevizeSpaces } from "@t3tools/client-runtime/trevize";
import { BanIcon, PlusIcon } from "lucide-react";
import { DynamicIcon } from "lucide-react/dynamic";
import { useState, type CSSProperties } from "react";

import { Button } from "~/components/ui/button";
import { ColorHueSlider, ColorSaturationValuePlane } from "~/components/ui/color-picker";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { hexToHsv, hsvToHex, type HsvColor } from "~/lib/color";
import { cn } from "~/lib/utils";
import { firstEmoji } from "~/projectIconOptions";
import { SpaceBadge, type Space } from "./Spaces";
import { SPACE_COLORS, SPACE_EMOJIS, filterSpaceIconNames } from "./spaceIconOptions";

export interface SpaceIconValue {
  /** A Lucide icon name or an emoji; null shows the space's initials. */
  readonly icon: string | null;
  /** `#rrggbb`; null uses the space's default tone. */
  readonly color: string | null;
}

const CELL_CLASS =
  "flex aspect-square items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-accent";
const SWATCH_CLASS =
  "flex size-6 items-center justify-center rounded-full border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-foreground/64";

const CUSTOM_SWATCH_GRADIENT = "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)";

function iconLabel(name: string): string {
  const words = name.split("-").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function CustomColorPanel(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const [hsv, setHsv] = useState<HsvColor>(() => hexToHsv(props.value));
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const commit = (next: HsvColor) => {
    setHsv(next);
    props.onChange(hsvToHex(next.h, next.s, next.v));
  };
  return (
    <div className="grid gap-3">
      <ColorSaturationValuePlane label="Space color" value={hsv} onChange={commit} />
      <ColorHueSlider
        label="Space color hue"
        value={hsv.h}
        onChange={(h) => commit({ ...hsv, h })}
      />
      <Input
        nativeInput
        size="compact"
        font="mono"
        spellCheck={false}
        aria-label="Custom hex color"
        value={hexDraft ?? hsvToHex(hsv.h, hsv.s, hsv.v)}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setHexDraft(next);
          const color = TrevizeSpaces.normalizeSpaceColor(next);
          if (color === null) return;
          setHsv(hexToHsv(color));
          props.onChange(color);
        }}
        onBlur={() => setHexDraft(null)}
      />
    </div>
  );
}

/**
 * The space's icon button; opens a picker for a Lucide icon or an emoji and
 * a color. Changes apply to the value at once; the caller saves them.
 */
export function SpaceIconPicker(props: {
  readonly space: Pick<Space, "id" | "name">;
  readonly value: SpaceIconValue;
  readonly disabled?: boolean;
  readonly onChange: (value: SpaceIconValue) => void;
}) {
  const { value, onChange } = props;
  const current = TrevizeSpaces.parseSpaceIcon(value.icon);
  const [mode, setMode] = useState<"icon" | "emoji">(current?.kind ?? "icon");
  const [query, setQuery] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const icons = filterSpaceIconNames(query);
  const presetColor = SPACE_COLORS.some((option) => option.value === value.color);
  const customColor = value.color !== null && !presetColor ? value.color : null;
  const tint: CSSProperties | undefined = value.color ? { color: value.color } : undefined;

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) return;
        setMode(current?.kind ?? "icon");
        setQuery("");
        setCustomOpen(customColor !== null);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="icon"
            variant="outline"
            disabled={props.disabled}
            aria-label="Change icon and color"
          />
        }
      >
        <SpaceBadge space={{ ...props.space, ...value }} size="lg" />
      </PopoverTrigger>
      <PopoverPopup align="start" padding="compact" width="md">
        <div className="grid gap-3">
          <ToggleGroup
            aria-label="Icon type"
            variant="segmented"
            value={[mode]}
            onValueChange={(next) => {
              const picked = next[0];
              if (picked === "icon" || picked === "emoji") setMode(picked);
            }}
          >
            <Toggle value="icon">Icons</Toggle>
            <Toggle value="emoji">Emoji</Toggle>
          </ToggleGroup>

          {mode === "icon" ? (
            <>
              <Input
                autoFocus
                size="sm"
                type="search"
                placeholder="Search icons"
                aria-label="Search icons"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
              <ScrollArea scrollFade className="max-h-56">
                <div className="grid grid-cols-8 gap-1 p-0.5">
                  {icons.map((name) => (
                    <button
                      key={name}
                      type="button"
                      aria-label={iconLabel(name)}
                      aria-pressed={current?.kind === "icon" && current.name === name}
                      className={cn(CELL_CLASS, !tint && "text-muted-foreground")}
                      style={tint}
                      onClick={() => onChange({ ...value, icon: name })}
                    >
                      <DynamicIcon name={name} className="size-4" />
                    </button>
                  ))}
                </div>
                {icons.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">No icons found.</p>
                ) : null}
              </ScrollArea>
            </>
          ) : (
            <>
              <Input
                autoFocus
                size="sm"
                placeholder="Type or paste any emoji"
                aria-label="Custom emoji"
                onChange={(event) => {
                  const emoji = firstEmoji(event.currentTarget.value);
                  if (emoji) onChange({ ...value, icon: emoji });
                }}
              />
              <ScrollArea scrollFade className="max-h-56">
                <div className="grid grid-cols-8 gap-1 p-0.5">
                  {SPACE_EMOJIS.map((option) => (
                    <button
                      key={option.emoji}
                      type="button"
                      aria-label={option.label}
                      aria-pressed={current?.kind === "emoji" && current.emoji === option.emoji}
                      className={cn(CELL_CLASS, "text-lg")}
                      onClick={() => onChange({ ...value, icon: option.emoji })}
                    >
                      {option.emoji}
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </>
          )}

          <div className="grid gap-2 border-t border-border pt-3">
            <div
              role="group"
              aria-label="Color"
              className="grid grid-cols-10 justify-items-center gap-y-1.5"
            >
              <button
                type="button"
                aria-label="Default color"
                aria-pressed={value.color === null}
                className={SWATCH_CLASS}
                onClick={() => {
                  setCustomOpen(false);
                  onChange({ ...value, color: null });
                }}
              >
                <BanIcon className="size-4 text-muted-foreground" />
              </button>
              {SPACE_COLORS.slice(0, 9).map((option) => (
                <ColorSwatch
                  key={option.value}
                  option={option}
                  selected={value.color === option.value}
                  onSelect={() => {
                    setCustomOpen(false);
                    onChange({ ...value, color: option.value });
                  }}
                />
              ))}
              <button
                type="button"
                aria-label="Custom color"
                aria-pressed={customColor !== null}
                aria-expanded={customOpen}
                className={SWATCH_CLASS}
                onClick={() => setCustomOpen((open) => !open)}
              >
                <span
                  className="flex size-4 items-center justify-center rounded-full"
                  style={{ background: customColor ?? CUSTOM_SWATCH_GRADIENT }}
                >
                  {customColor ? null : <PlusIcon className="size-3 text-white" />}
                </span>
              </button>
              {SPACE_COLORS.slice(9).map((option) => (
                <ColorSwatch
                  key={option.value}
                  option={option}
                  selected={value.color === option.value}
                  onSelect={() => {
                    setCustomOpen(false);
                    onChange({ ...value, color: option.value });
                  }}
                />
              ))}
            </div>
            {customOpen ? (
              <CustomColorPanel
                value={value.color ?? SPACE_COLORS[7]?.value ?? "#7c3aed"}
                onChange={(color) => onChange({ ...value, color })}
              />
            ) : null}
          </div>

          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={value.icon === null && value.color === null}
            onClick={() => {
              setCustomOpen(false);
              onChange({ icon: null, color: null });
            }}
          >
            <BanIcon />
            Reset icon and color
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function ColorSwatch(props: {
  readonly option: { readonly value: string; readonly label: string };
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={props.option.label}
      aria-pressed={props.selected}
      className={SWATCH_CLASS}
      onClick={props.onSelect}
    >
      <span className="size-4 rounded-full" style={{ backgroundColor: props.option.value }} />
    </button>
  );
}
