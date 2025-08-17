import { Injectable } from '@angular/core';
import { pipeline } from '@huggingface/transformers';

@Injectable({ providedIn: 'root' })
export class SentimentService {
    private sentiment: any;

    constructor() {
        this.loadModel();
    }

    async loadModel() {
        this.sentiment = await pipeline('sentiment-analysis');
    }

    async analyze(text: string) {
        if (!this.sentiment) {
            return [{ label: 'loading', score: 0 }];
        }
        return await this.sentiment(text);
    }
}
