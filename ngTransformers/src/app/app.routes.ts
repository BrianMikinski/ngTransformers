import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./sloth-rag/sloth-rag').then(m => m.SlothRag) },
  { path: 'sentiment', loadComponent: () => import('./sentiment/sentiment').then(m => m.Sentiment) },
  { path: 'sloth-rag', redirectTo: '' }, // old link
  { path: '**', redirectTo: '' }
];
