"use client";

import { CaretDown, type Icon } from "@phosphor-icons/react";
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "motion/react";
import { useId, useState } from "react";
import { EASE_OUT, spring } from "@/lib/motion-tokens";
import { cn } from "@/lib/utils";

type SectionProps = {
  title: React.ReactNode;
  /** Optional leading Phosphor icon, filled. */
  icon?: Icon;
  /** Right-aligned secondary text, e.g. a count or a time. */
  meta?: React.ReactNode;
  open: boolean;
  onToggle: (fromKeyboard: boolean) => void;
  disabled?: boolean;
  /** Skip the height animation (keyboard toggles). */
  instant: boolean;
  className?: string;
  children: React.ReactNode;
};

/** One header + body pair; shared by Accordion items and Collapsible. */
function Section({
  title,
  icon: IconComponent,
  meta,
  open,
  onToggle,
  disabled,
  instant,
  className,
  children,
}: SectionProps) {
  const id = useId();
  const reduce = useReducedMotion();
  const still = instant || !!reduce;

  return (
    <div className={cn("rounded-xl", className)}>
      <h3>
        <button
          type="button"
          id={`${id}-trigger`}
          aria-expanded={open}
          aria-controls={`${id}-body`}
          disabled={disabled}
          onClick={(e) => onToggle(e.detail === 0)}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-[background-color,scale] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-foreground/[0.03] active:scale-[0.99] disabled:opacity-40"
        >
          {IconComponent && (
            <IconComponent
              weight="fill"
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
            />
          )}
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {meta && (
            <span className="shrink-0 text-[0.8125rem] font-normal text-muted-foreground">
              {meta}
            </span>
          )}
          <CaretDown
            weight="bold"
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-[cubic-bezier(0.77,0,0.175,1)]",
              open && "rotate-180",
              still && "transition-none",
            )}
          />
        </button>
      </h3>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={`${id}-body`}
            role="region"
            aria-labelledby={`${id}-trigger`}
            initial={{ height: 0, opacity: 0 }}
            animate={{
              height: "auto",
              opacity: 1,
              transition: still
                ? { duration: 0 }
                : { height: spring, opacity: { duration: 0.2, ease: EASE_OUT } },
            }}
            exit={{
              height: 0,
              opacity: 0,
              transition: still
                ? { duration: 0 }
                : { height: { ...spring, duration: 0.22 }, opacity: { duration: 0.12 } },
            }}
            className="overflow-hidden"
          >
            <div className="px-3 pt-0.5 pb-3 text-[0.8125rem] text-muted-foreground">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export type AccordionItem = {
  id: string;
  title: React.ReactNode;
  icon?: Icon;
  meta?: React.ReactNode;
  content: React.ReactNode;
  disabled?: boolean;
};

export type AccordionProps = {
  items: AccordionItem[];
  /** `single` keeps at most one item open; `multiple` lets any number open. */
  type?: "single" | "multiple";
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (open: string[]) => void;
  className?: string;
};

/** A list of collapsible sections. Items separate by spacing, not dividers. */
export function Accordion({
  items,
  type = "single",
  value: valueProp,
  defaultValue = [],
  onValueChange,
  className,
}: AccordionProps) {
  const [inner, setInner] = useState(defaultValue);
  const open = valueProp ?? inner;
  const [instant, setInstant] = useState(false);

  const toggle = (id: string, fromKeyboard: boolean) => {
    setInstant(fromKeyboard);
    const isOpen = open.includes(id);
    const next = isOpen
      ? open.filter((o) => o !== id)
      : type === "single"
        ? [id]
        : [...open, id];
    if (valueProp === undefined) setInner(next);
    onValueChange?.(next);
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className={cn("flex flex-col gap-0.5", className)}>
        {items.map((item) => (
          <Section
            key={item.id}
            title={item.title}
            icon={item.icon}
            meta={item.meta}
            disabled={item.disabled}
            open={open.includes(item.id)}
            instant={instant}
            onToggle={(fromKeyboard) => toggle(item.id, fromKeyboard)}
            className={open.includes(item.id) ? "bg-foreground/[0.03]" : undefined}
          >
            {item.content}
          </Section>
        ))}
      </div>
    </MotionConfig>
  );
}

export type CollapsibleProps = {
  title: React.ReactNode;
  icon?: Icon;
  meta?: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
};

/** A single collapsible section, e.g. reasoning or details under an answer. */
export function Collapsible({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  ...props
}: CollapsibleProps) {
  const [inner, setInner] = useState(defaultOpen);
  const open = openProp ?? inner;
  const [instant, setInstant] = useState(false);

  return (
    <MotionConfig reducedMotion="user">
      <Section
        {...props}
        open={open}
        instant={instant}
        onToggle={(fromKeyboard) => {
          setInstant(fromKeyboard);
          if (openProp === undefined) setInner(!open);
          onOpenChange?.(!open);
        }}
        className={cn("bg-foreground/[0.03]", props.className)}
      />
    </MotionConfig>
  );
}
