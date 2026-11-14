import { Component, ChangeDetectionStrategy } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <header class="sticky top-0 z-10 border-b border-line bg-bg/80 backdrop-blur">
      <nav class="mx-auto flex h-14 max-w-5xl items-center gap-6 px-4 sm:px-6">
        <a routerLink="/" class="mr-auto text-[15px] font-semibold tracking-tight">ngTransformers</a>
        <a routerLink="/" routerLinkActive="!text-fg" [routerLinkActiveOptions]="{ exact: true }"
           class="text-sm text-muted transition-colors hover:text-fg">Sentiment</a>
        <a routerLink="/sloth-rag" routerLinkActive="!text-fg"
           class="text-sm text-muted transition-colors hover:text-fg">Sloth RAG</a>
      </nav>
    </header>
    <main class="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
      <router-outlet />
    </main>
  `
})
export class App {}
