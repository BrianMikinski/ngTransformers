import { Component, ChangeDetectionStrategy } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <header class="sticky top-0 z-10 border-b border-line bg-bg/80 backdrop-blur">
      <nav class="flex h-14 items-center gap-6 px-4">
        <a routerLink="/" class="text-[15px] font-semibold tracking-tight">Sloth RAG 🦥</a>
        <a href="https://www.linkedin.com/in/brianmikinski/" target="_blank" rel="noopener noreferrer"
           aria-label="By Brian Mikinski on LinkedIn (opens in a new tab)"
           class="mr-auto -ml-2 flex items-center gap-1.5 border-l border-line pl-4 text-xs text-muted transition-colors hover:text-fg">
          <svg class="h-4 w-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#0A66C2" d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z"/>
          </svg>
          <span>By Brian Mikinski</span>
        </a>
        <a routerLink="/sentiment" routerLinkActive="!text-fg"
           class="text-xs text-subtle transition-colors hover:text-fg">Sentiment demo</a>
      </nav>
    </header>
    <main>
      <router-outlet />
    </main>
  `
})
export class App {}
