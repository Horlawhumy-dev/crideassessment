import { Popover as PopoverPrimitive } from '@base-ui/react/popover';

import { cn } from '@/lib/utils';

/**
 * The design-system wrapper around Base UI's popover.
 *
 * Base UI owns the behaviour that is genuinely hard — focus trapping, escape,
 * outside-click, the anchored position and its flip/shift logic — and this file
 * owns only the tokens. The split matters because `features/` cannot contain
 * colour literals (`npm run check:styles`), so every surface that floats above the
 * page needs a primitive here to express itself in.
 */
export function Popover(props: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root {...props} />;
}

export function PopoverTrigger(props: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger {...props} />;
}

export function PopoverPortal(props: PopoverPrimitive.Portal.Props) {
  return <PopoverPrimitive.Portal {...props} />;
}

export function PopoverPositioner({ className, ...props }: PopoverPrimitive.Positioner.Props) {
  return (
    <PopoverPrimitive.Positioner
      className={cn(
        'z-50',
        // Above the sticky header (z-20) and the bottom nav (z-20). Without this
        // the panel renders *under* the app shell on a phone, which is where most
        // of this app is used.
        className,
      )}
      {...props}
    />
  );
}

export function PopoverPopup({ className, ...props }: PopoverPrimitive.Popup.Props) {
  return (
    <PopoverPrimitive.Popup
      className={cn(
        'bg-popover text-popover-foreground origin-(--transform-origin) rounded-2xl border border-border shadow-lg',
        'transition-transform transition-opacity outline-none',
        'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
        'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
        className,
      )}
      {...props}
    />
  );
}

export function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return <PopoverPrimitive.Title className={cn('text-sm font-semibold', className)} {...props} />;
}

export function PopoverDescription({ className, ...props }: PopoverPrimitive.Description.Props) {
  return <PopoverPrimitive.Description className={cn('text-muted-foreground text-xs', className)} {...props} />;
}

export function PopoverClose({ className, ...props }: PopoverPrimitive.Close.Props) {
  return <PopoverPrimitive.Close className={cn(className)} {...props} />;
}

export { PopoverPrimitive };