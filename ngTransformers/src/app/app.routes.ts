import { Routes } from '@angular/router';
import { Sentiment } from './sentiment/sentiment';

export const routes: Routes = [
  { path: '', component: Sentiment },
  { path: 'sloth-rag', loadComponent: () => import('./sloth-rag/sloth-rag').then(m => m.SlothRag) },
  { path: '**', redirectTo: '' }
];
