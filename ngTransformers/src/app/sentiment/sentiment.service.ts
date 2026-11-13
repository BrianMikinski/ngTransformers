import { Injectable } from '@angular/core';
import { pipeline} from '@huggingface/transformers';

@Injectable({ providedIn: 'root' })
export class SentimentService {
    private sentiment: any;

    constructor() {
        this.loadModel();
    }

    async loadModel() {
        try {

            this.sentiment = await pipeline(
                'sentiment-analysis',
                'Xenova/distilbert-base-uncased-finetuned-sst-2-english'
            );
            
        } catch (error: any) {
            console.error('Error loading sentiment model:', error?.cause ?? error);
        }
    }

    async analyze(text: string) {
        if (!this.sentiment) {
            return [{ label: 'loading', score: 0 }];
        }
        return await this.sentiment(text);
    }
}
