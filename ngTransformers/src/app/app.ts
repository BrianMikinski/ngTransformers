import { Component, ChangeDetectionStrategy } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <nav>
      <a routerLink="/">Sentiment</a> |
      <a routerLink="/sloth-rag">Sloth RAG</a>
    </nav>
    <hr />
    <router-outlet />
  `
})
export class App {}
