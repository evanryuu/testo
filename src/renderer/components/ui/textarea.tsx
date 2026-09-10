import * as React from "react"
import { cn } from "@/lib/utils"
import { attachOverlayScrollbars } from "@/lib/scrollbars"

function Textarea({ className, ref, ...props }: React.ComponentProps<"textarea">) {
  const viewport = React.useRef<HTMLTextAreaElement>(null)
  const slot = React.useRef<HTMLSpanElement>(null)
  React.useImperativeHandle(ref, () => viewport.current!, [])
  React.useLayoutEffect(() => attachOverlayScrollbars(viewport.current!, slot.current!), [])
  return (
    <span ref={slot} className="relative block w-full">
      <textarea
        ref={viewport}
        data-slot="textarea"
        className={cn(
          "flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:ring-destructive/40",
          className
        )}
        {...props}
      />
    </span>
  )
}

export { Textarea }
