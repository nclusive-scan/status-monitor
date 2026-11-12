import { cn } from "@/lib/utils";

/**
 * Placeholder block. A slow opacity pulse — no shimmer sweep — and static
 * under reduced motion. Size it with className (h-*, w-*, rounded-*).
 */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "animate-pulse rounded-lg bg-foreground/[0.06] motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

/** Wraps skeletons so assistive tech hears one "Loading" instead of empty blocks. */
export function SkeletonGroup({
  label = "Loading",
  className,
  children,
}: {
  label?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

const lineWidths = ["w-11/12", "w-4/5", "w-3/5"];

/** An assistant message loading: avatar and three lines of varied width. */
export function MessageSkeleton({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <SkeletonGroup label="Loading message" className={cn("flex gap-3", className)}>
      <Skeleton className="size-7 shrink-0 rounded-full" />
      <div className="flex flex-1 flex-col gap-2 pt-1">
        <Skeleton className="h-3 w-24" />
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton
            key={i}
            className={cn("h-3", lineWidths[i % lineWidths.length])}
            style={{ animationDelay: `${(i + 1) * 120}ms` }}
          />
        ))}
      </div>
    </SkeletonGroup>
  );
}

/** A card loading: media area, title and meta. */
export function CardSkeleton({
  media = true,
  className,
}: {
  media?: boolean;
  className?: string;
}) {
  return (
    <SkeletonGroup
      label="Loading card"
      className={cn("flex flex-col gap-2.5 rounded-2xl bg-surface-inset p-2", className)}
    >
      {media && <Skeleton className="aspect-[16/10] w-full rounded-xl" />}
      <div className="flex flex-col gap-2 px-1 pb-1">
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3 w-1/2" style={{ animationDelay: "120ms" }} />
      </div>
    </SkeletonGroup>
  );
}
