// sharing the Catppuccin Mocha accents between the service worker (importScripts) and the pages
self.PALETTE = ['#fab387', '#a6e3a1', '#cba6f7', '#89b4fa', '#f9e2af', '#f5c2e7', '#94e2d5', '#b4befe'];
self.PALETTE_NAMES = ['Peach', 'Green', 'Mauve', 'Blue', 'Yellow', 'Pink', 'Teal', 'Lavender'];
self.INK = '#1e1e2e';
self.initial = (name) => ([...(name || '').trim()][0] || '?').toUpperCase();
