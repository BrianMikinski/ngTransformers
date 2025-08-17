import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Component, inject, signal } from '@angular/core';
import { pipeline, TextClassificationPipeline } from '@huggingface/transformers';
import { SentimentService } from './sentitment.service';

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
  result = '';

  pipeline!: TextClassificationPipeline;

  #sentimentService: SentimentService = inject(SentimentService);

  async loadModel() {
    // Preload pipeline on init to reduce latency
    this.pipeline = await pipeline('sentiment-analysis') as any;
  }

  async analyze() {
    this.result = await this.#sentimentService.analyze(this.inputText);
  }

}
