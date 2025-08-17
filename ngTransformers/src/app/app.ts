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

  inputText = 'I love using Angular!';
  result: any = "";

  #sentimentService: SentimentService = inject(SentimentService);

  async analyze() {
    this.result = await this.#sentimentService.analyze(this.inputText);
  }

}
