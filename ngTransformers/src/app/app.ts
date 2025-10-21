import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Component, inject, signal } from '@angular/core';
import { SentimentService } from './sentiment.service';

@Component({
  selector: 'app-root',
  imports: [
    CommonModule,
    FormsModule
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  protected readonly title = signal('ngTransformers');

  // Use signals for reactive state in zoneless mode
  inputText = signal('I love using Angular!');
  result = signal<any>('');

  #sentimentService: SentimentService = inject(SentimentService);

  async analyze() {
    const text = this.inputText();
    const analysisResult = await this.#sentimentService.analyze(text);
    this.result.set(analysisResult);
  }

}
