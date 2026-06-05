'use client';

import { useState, useEffect, useRef } from 'react';
import { Menu, X } from 'lucide-react';
import { Sidebar } from '@/components/docs/sidebar';

export function MobileDrawer() {
  const [open, setOpen] = useState(false);
  const scrollYRef = useRef(0);

  useEffect(() => {
    if (open) {
      scrollYRef.current = window.scrollY;
      document.body.style.position = 'fixed';
      document.body.style.top = `-${scrollYRef.current}px`;
      document.body.style.width = '100%';
    } else {
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      window.scrollTo(0, scrollYRef.current);
    }
    return () => {
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
    };
  }, [open]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-md text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] lg:hidden"
        aria-label="Open menu"
      >
        <Menu size={20} />
      </button>

      {/* Backdrop & Drawer Container */}
      <div
        className={`fixed inset-0 z-50 flex lg:hidden transition-opacity duration-300 ${
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Backdrop overlay */}
        <div
          className="absolute inset-0 bg-[#191816]/40 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        />

        {/* Sidebar drawer */}
        <aside
          className={`absolute left-0 top-0 h-full w-72 border-r border-[var(--color-border)] bg-[var(--color-bg)] p-6 overflow-y-auto transition-transform duration-300 ease-in-out ${
            open ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <button
            onClick={() => setOpen(false)}
            className="mb-6 inline-flex min-h-10 min-w-10 items-center justify-center rounded-md text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
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
