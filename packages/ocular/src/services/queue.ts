import {
  Kafka,
  Message,
  Producer,
  ProducerBatch,
  TopicMessages,
} from "kafkajs";
import {
  Consumer,
  ConsumerContext,
  TransactionBaseService,
  AbstractQueueService,
  Logger,
} from "@ocular/types";
import { ulid } from "ulid";
import { IndexableDocument } from "@ocular/types";

type InjectedDependencies = {
  logger: Logger;
  kafkaClient: Kafka;
};

export default class QueueService extends AbstractQueueService {
  protected logger_: Logger;
  protected kafkaClient_: Kafka;
  protected producer_: Producer;

  constructor({ logger, kafkaClient }: InjectedDependencies) {
    // @ts-ignore
    // eslint-disable-next-line prefer-rest-params
    super(...arguments);
    this.logger_ = logger;
    try {
      this.kafkaClient_ = kafkaClient;
      this.producer_ = kafkaClient.producer();
    } catch (error) {
      this.logger_.error(
        `queueService: Error creating Kafka producer: ${error.message}`
      );
    }

    process.on("exit", async () => {
      this.logger_.info("queueService: Disconnecting all consumers");
      await this.clearConsumers();
    });
  }

  async send<T>(
    topicName: string,
    data: T,
    options?: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.producer_.connect();
      const record = await this.producer_.send({
        topic: topicName,
        messages: [{ value: JSON.stringify(data) }],
      });
      await this.producer_.disconnect();
    } catch (error) {
      this.logger_.error(
        `send: Error sending message to Kafka: ${error.message}`
      );
    }
  }

  async sendBatch<T>(
    topicName: string,
    data: T[],
    options?: Record<string, unknown>
  ): Promise<void> {
    // Track And Count The Number of Messages Sent To Indexing Queue
    try {
      await this.producer_.connect();
      const messages = data.map((doc) => {
        return { value: JSON.stringify(doc) };
      });
      const topicMessages: TopicMessages = {
        topic: topicName,
        messages: messages,
      };
      const batch: ProducerBatch = {
        topicMessages: [topicMessages],
      };
      await this.producer_.sendBatch(batch);
      await this.producer_.disconnect();
    } catch (error) {
      this.logger_.error(
        `sendBatch:Error sending batch message to Kafka: ${error.message}`
      );
    }
  }

  async subscribe<T>(
    topicName: string,
    consumer: Consumer,
    context: ConsumerContext
  ): Promise<void> {
    // Check if the consumer is a function
    if (typeof consumer !== `function`) {
      throw new Error("Subscriber must be a function");
    }
    console.log(`Subscribing to topic ${topicName}`);
    const kafkaConsumer = await this.kafkaClient_.consumer({
      groupId: context.groupId,
    });
    await kafkaConsumer.connect();
    await kafkaConsumer.subscribe({ topic: topicName, fromBeginning: false });
    kafkaConsumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        const doc: IndexableDocument = JSON.parse(message.value.toString());
        consumer([doc], topic).catch((error) => {
          this.logger_.error(`Error processing message: ${error.message}`);
        });
      },
    });

    const randId = ulid();
    const topic = topicName.toString();

    this.storeConsumers({
      topicName,
      consumerId: `${topic}-${randId}`,
      consumer: kafkaConsumer,
    });
  }

  async subscribeBatch<T>(
    topicName: string,
    consumer: Consumer,
    context: ConsumerContext
  ): Promise<void> {
    try {
      if (typeof consumer !== `function`) {
        throw new Error("Subscriber must be a function");
      }
      const kafkaConsumer = this.kafkaClient_.consumer({
        groupId: context.groupId,
        sessionTimeout: 60000, // 60 seconds
      });
      kafkaConsumer.connect();
      kafkaConsumer.subscribe({ topic: topicName, fromBeginning: false });
      kafkaConsumer.run({
        eachBatchAutoResolve: true,
        eachBatch: async ({ batch, heartbeat }) => {
          try {
            // Start Tracking The Activity of The Indexing Process
            const eachBatchProcessingActivity = this.logger_.activity(
              `eachBatch: Batch Received ${batch.messages.length} messages in topic ${topicName}\n`
            );
            const docs: IndexableDocument[] = batch.messages.map((message) => {
              return JSON.parse(message.value.toString()) as IndexableDocument;
            });

            for (let i = 0; i < docs.length; i++) {
              await consumer([docs[i]], topic);
              this.logger_.progress(
                eachBatchProcessingActivity,
                `eachBatch: Indexed ${i} messages Out of  Received ${batch.messages.length} messages in topic ${topicName}\n`
              );
              await heartbeat();
            }

            this.logger_.success(
              eachBatchProcessingActivity,
              `eachBatch: Finished Batch Processing ${batch.messages.length} messages in topic ${topicName}\n`
            );
          } catch (error) {
            this.logger_.error(
              `eachBatch: Error processing message: ${error.message}`
            );
          }
        },
      });

      const randId = ulid();
      const topic = topicName.toString();

      this.storeConsumers({
        topicName,
        consumerId: `${topic}-${randId}`,
        consumer: kafkaConsumer,
      });
    } catch (error) {
      this.logger_.error(
        `subscribeBatch: Error subscribing to topic: ${error.message}`
      );
    }
  }
}
