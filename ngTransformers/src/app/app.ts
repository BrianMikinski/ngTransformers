import { Component, ChangeDetectionStrategy } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <header class="sticky top-0 z-10 border-b border-line bg-bg/80 backdrop-blur">
      <nav class="flex h-14 items-center gap-6 px-4">
        <a routerLink="/" class="mr-auto text-[15px] font-semibold tracking-tight">Sloth RAG 🦥</a>
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
