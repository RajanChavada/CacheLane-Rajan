'use client';

import { useState, useEffect } from 'react';
import { Menu, X } from 'lucide-react';
import { Sidebar } from '@/components/docs/sidebar';

export function MobileDrawer() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  return (
    <>
      {/* Menu Hamburger Button */}
      <button
        onClick={() => setOpen(true)}
        className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-md text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] lg:hidden cursor-pointer"
        aria-label="Open menu"
      >
        <Menu size={20} />
      </button>

      {/* Root Overlay Container (instant toggle of display visibility) */}
      <div
        className={`fixed inset-0 z-50 flex lg:hidden ${
          open ? 'visible pointer-events-auto' : 'invisible pointer-events-none'
        }`}
      >
        {/* Backdrop overlay (fades in/out) */}
        <div
          className={`absolute inset-0 bg-[#191816]/40 backdrop-blur-sm transition-opacity duration-300 ease-out ${
            open ? 'opacity-100' : 'opacity-0'
          }`}
          onClick={() => setOpen(false)}
        />

        {/* Sidebar drawer (slides in/out) */}
        <aside
          className={`absolute left-0 top-0 h-full w-72 border-r border-[var(--color-border)] bg-[var(--color-bg)] p-6 overflow-y-auto transition-transform duration-300 ease-in-out ${
            open ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <button
            onClick={() => setOpen(false)}
            className="mb-6 inline-flex min-h-10 min-w-10 items-center justify-center rounded-md text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] cursor-pointer"
            aria-label="Close menu"
          >
            <X size={20} />
          </button>
          <Sidebar onNavigate={() => setOpen(false)} />
        </aside>
      </div>
    </>
  );
}
