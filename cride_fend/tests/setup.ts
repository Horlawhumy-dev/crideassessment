import '@testing-library/jest-dom/vitest';

/**
 * jsdom has no `matchMedia`, and Base UI's `Switch` and `Field` both consult it
 * for a reduced-motion preference. Without this every component test fails on a
 * method that does not exist, which looks like a component bug and is not one.
 */
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
