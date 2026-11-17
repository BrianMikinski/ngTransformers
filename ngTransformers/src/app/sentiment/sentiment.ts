import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { SentimentService } from './sentiment.service';

@Component({
  selector: 'app-sentiment',
  imports: [
    CommonModule,
    FormsModule
  ],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './sentiment.html'
})
export class Sentiment {

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
