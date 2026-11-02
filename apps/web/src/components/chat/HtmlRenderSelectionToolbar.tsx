import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  MessageId,
  type AssistantCitation,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { QuoteIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { isSelectionRectVisible, resolveSelectionActionPosition } from "~/lib/selectionActions";

import type { HtmlRenderSelection } from "../files/BrowserDocumentFrame";
import { Button } from "../ui/button";

/**
 * Cites text selected inside a sandboxed HTML render. The page's DOM is unreachable, so the
 * comment popup anchors to a marker laid over the selection. The marker stays mounted because
 * the comment source closes on child-list changes inside its container.
 */
export function HtmlRenderSelectionToolbar(props: {
  readonly selection: HtmlRenderSelection | null;
  readonly sourceId: string;
  readonly threadRef: ScopedThreadRef;
  readonly onCite: (
    citation: AssistantCitation,
    sourceAnchor: AssistantCitationSourceAnchor,
  ) => boolean;
  readonly onDismiss: () => void;
}) {
  const { selection, onDismiss } = props;
  const markerRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the timeline viewport and frame to place the marker and button before paint
  useLayoutEffect(() => {
    const marker = markerRef.current;
    const button = buttonRef.current;
    const source = marker?.parentElement;
    const viewport = source?.closest<HTMLElement>("[data-assistant-citation-viewport]");
    if (!selection || !marker || !button || !source || !viewport) return;
    const bounds = viewport.getBoundingClientRect();
    if (!isSelectionRectVisible(selection.rect, [bounds])) {
      onDismiss();
      return;
    }
    const origin = source.getBoundingClientRect();
    Object.assign(marker.style, {
      left: `${selection.rect.left - origin.left}px`,
      top: `${selection.rect.top - origin.top}px`,
      width: `${selection.rect.width}px`,
      height: `${selection.rect.height}px`,
    });
    const point = resolveSelectionActionPosition({
      bounds,
      selectionRect: selection.rect,
      pointer: null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    const size = button.getBoundingClientRect();
    button.style.left = `${Math.max(8, Math.min(point.x, window.innerWidth - size.width - 8))}px`;
    button.style.top = `${Math.max(8, Math.min(point.y, window.innerHeight - size.height - 8))}px`;
  }, [onDismiss, selection]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- dismisses the fixed button when the app scrolls, resizes, or is clicked elsewhere
  useEffect(() => {
    if (!selection) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!buttonRef.current?.contains(event.target as Node)) onDismiss();
    };
    const dismiss = () => onDismiss();
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [onDismiss, selection]);

  const tooLong = selection !== null && selection.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
  const cite = () => {
    const marker = markerRef.current;
    const source = marker?.parentElement;
    const viewport = source?.closest<HTMLElement>("[data-assistant-citation-viewport]");
    if (!selection || tooLong || !marker || !source || !viewport) return;
    const range = document.createRange();
    range.selectNode(marker);
    const citation: AssistantCitation = {
      version: 1,
      ...props.threadRef,
      messageId: MessageId.make(props.sourceId),
      text: selection.text,
      start: 0,
      end: selection.text.length,
      prefix: "",
      suffix: "",
    };
    if (props.onCite(citation, { source, range, viewport })) onDismiss();
  };

  return (
    <>
      <span ref={markerRef} aria-hidden="true" className="pointer-events-none absolute" />
      {selection
        ? createPortal(
            <Button
              ref={buttonRef}
              type="button"
              size="xs"
              variant="glass"
              disabled={tooLong}
              aria-label={tooLong ? "Selection is too long to cite" : "Cite selection in composer"}
              className="fixed z-50 max-w-[calc(100vw-1rem)]"
              onPointerDown={(event) => event.preventDefault()}
              onClick={cite}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  onDismiss();
                }
              }}
            >
              <QuoteIcon aria-hidden="true" className="size-3.5" />
              {tooLong ? "Shorten selection" : "Cite"}
            </Button>,
            document.body,
          )
        : null}
    </>
  );
}
