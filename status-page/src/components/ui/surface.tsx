import type { Icon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

/*
 * Edited for this status page: a flat card instead of TUFFUI's layered frame. A `Shell` is one card with a 1px hairline
 * border; `Panel`s inside it are transparent and divided by hairlines; an `Inset` is a quiet tinted block. The charts
 * (chart-card, stat-grid, tick-gauge) take their frame from here, so they read as ordinary shadcn cards.
 */

type DivProps = React.ComponentProps<"div">;

/** Outer frame. Headers and footers sit in its padding, content in panels. */
export function Shell({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="shell"
      className={cn("@container w-full overflow-hidden rounded-xl border bg-card text-card-foreground", className)}
      {...props}
    />
  );
}

/** Main content area inside a shell. */
export function Panel({ className, ...props }: DivProps) {
  return <div data-slot="panel" className={cn("[[data-slot=panel]+&]:border-t", className)} {...props} />;
}

/** One level deeper: code, payloads, details inside a panel. */
export function Inset({ className, ...props }: DivProps) {
  return <div className={cn("rounded-lg bg-muted/60", className)} {...props} />;
}

/** Icon in a tinted square. Pass a Phosphor icon, or children for anything else. */
export function IconTile({
  icon: IconComponent,
  className,
  children,
  ...props
}: DivProps & { icon?: Icon }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center text-muted-foreground",
        className,
      )}
      {...props}
    >
      {IconComponent ? <IconComponent weight="light" className="size-4" /> : children}
    </div>
  );
}

export type ShellHeaderProps = Omit<DivProps, "title"> & {
  icon?: Icon;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Right side: a stat, a pill or actions. Vertically centered with the title. */
  aside?: React.ReactNode;
  /** Heading level for the title. */
  as?: "h2" | "h3" | "h4";
};

/**
 * Header row for a shell. The icon tile sits 12px from the shell edge, in line
 * with panel content below it, and everything is vertically centered.
 */
export function ShellHeader({
  icon,
  title,
  subtitle,
  aside,
  as: Heading = "h3",
  className,
  ...props
}: ShellHeaderProps) {
  return (
    <div
      className={cn("flex items-center gap-2.5 px-4 pt-4 pb-2", className)}
      {...props}
    >
      {icon && <IconTile icon={icon} />}
      <div className="min-w-0 flex-1">
        <Heading className="text-sm font-medium text-pretty">{title}</Heading>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
    </div>
  );
}
