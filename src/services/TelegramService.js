import axios from 'axios';

export class TelegramService {
  constructor() {
    // Check which service to use
    this.discordWebhook = process.env.DISCORD_WEBHOOK_URL;
    this.telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    this.telegramChatId = process.env.TELEGRAM_CHAT_ID;
    
    if (this.discordWebhook) {
      this.service = 'discord';
      this.enabled = true;
      console.log('📱 Discord notifications enabled');
    } else if (this.telegramToken && this.telegramChatId) {
      this.service = 'telegram';
      this.enabled = true;
      console.log('📱 Telegram notifications enabled');
    } else {
      this.enabled = false;
      console.warn('⚠️ No notification service configured');
    }
  }

  async sendSignal(signal) {
    if (!this.enabled) {
      console.log('📱 [DISABLED] Would send:', signal.action, signal.symbol);
      return;
    }

    if (this.service === 'discord') {
      await this.sendDiscordSignal(signal);
    } else {
      await this.sendTelegramSignal(signal);
    }
  }

  async sendDiscordSignal(signal) {
    const color = signal.action === 'BUY' ? 0x00ff00 : 0xff0000;
    const emoji = signal.action === 'BUY' ? '🟢' : '🔴';

    const embed = {
      embeds: [{
        title: `${emoji} ${signal.action} SIGNAL`,
        color: color,
        fields: [
          { name: '📊 Symbol', value: `\`${signal.symbol}\``, inline: true },
          { name: '💰 Price', value: `\`${this.formatPrice(signal.price)}\``, inline: true },
          { name: '📈 Confidence', value: `${signal.confidence}%`, inline: true },
          { name: '🛑 Stop Loss', value: `\`${this.formatPrice(signal.stopLoss)}\``, inline: true },
          { name: '🎯 Take Profit', value: `\`${this.formatPrice(signal.takeProfit)}\``, inline: true },
          { name: '📊 Risk/Reward', value: '1:1.5', inline: true },
          { name: '📉 RSI', value: signal.indicators.rsi || 'N/A', inline: true },
          { name: '📊 MACD', value: signal.indicators.macd || 'N/A', inline: true },
          { name: '💪 ADX', value: signal.indicators.adx || 'N/A', inline: true },
          { name: '📝 Reasons', value: signal.reasons.map(r => `• ${r}`).join('\n') || 'N/A', inline: false }
        ],
        footer: {
          text: `⚠️ Not financial advice | ${process.env.MT5_ENABLED === 'true' ? '🤖 Auto-executing' : '👆 Manual execution'}`
        },
        timestamp: new Date().toISOString()
      }]
    };

    try {
      await axios.post(this.discordWebhook, embed);
      console.log('📱 Signal sent to Discord');
    } catch (err) {
      console.error('❌ Discord send failed:', err.message);
    }
  }

  async sendTelegramSignal(signal) {
    const emoji = signal.action === 'BUY' ? '🟢' : '🔴';
    const arrow = signal.action === 'BUY' ? '📈' : '📉';

    const message = `
${emoji} *${signal.action} SIGNAL* ${arrow}

*Symbol:* \`${signal.symbol}\`
*Price:* \`${this.formatPrice(signal.price)}\`
*Confidence:* ${signal.confidence}%

*Targets:*
🛑 Stop Loss: \`${this.formatPrice(signal.stopLoss)}\`
🎯 Take Profit: \`${this.formatPrice(signal.takeProfit)}\`
📊 Risk/Reward: 1:1.5

*Indicators:*
• RSI: ${signal.indicators.rsi}
• MACD: ${signal.indicators.macd}
• ADX: ${signal.indicators.adx}

*Reasons:*
${signal.reasons.map(r => `• ${r}`).join('\n')}

⏰ ${new Date().toLocaleString()}

${process.env.MT5_ENABLED === 'true' ? '🤖 _Auto-executing on MT5..._' : '👆 _Manual execution required_'}

⚠️ _Not financial advice. Trade at your own risk._
    `;

    try {
      await axios.post(`https://api.telegram.org/bot${this.telegramToken}/sendMessage`, {
        chat_id: this.telegramChatId,
        text: message,
        parse_mode: 'Markdown'
      });
      console.log('📱 Signal sent to Telegram');
    } catch (err) {
      console.error('❌ Telegram send failed:', err.message);
    }
  }

  async sendMessage(text) {
    if (!this.enabled) return;

    if (this.service === 'discord') {
      try {
        await axios.post(this.discordWebhook, { content: text.replace(/\*/g, '**').replace(/_/g, '*') });
      } catch (err) {
        console.error('❌ Discord send failed:', err.message);
      }
    } else {
      try {
        await axios.post(`https://api.telegram.org/bot${this.telegramToken}/sendMessage`, {
          chat_id: this.telegramChatId,
          text: text,
          parse_mode: 'Markdown'
        });
      } catch (err) {
        console.error('❌ Telegram send failed:', err.message);
      }
    }
  }

  async sendTradeExecuted(trade) {
    if (!this.enabled) return;

    const emoji = trade.type === 'BUY' ? '✅' : '🔻';
    
    if (this.service === 'discord') {
      const embed = {
        embeds: [{
          title: `${emoji} TRADE EXECUTED ON MT5`,
          color: trade.type === 'BUY' ? 0x00ff00 : 0xff0000,
          fields: [
            { name: 'Type', value: trade.type, inline: true },
            { name: 'Symbol', value: trade.symbol, inline: true },
            { name: 'Price', value: this.formatPrice(trade.price), inline: true },
            { name: 'Lot Size', value: trade.lotSize.toString(), inline: true },
            { name: 'Ticket', value: `#${trade.ticket}`, inline: true },
            { name: 'SL', value: this.formatPrice(trade.stopLoss), inline: true },
            { name: 'TP', value: this.formatPrice(trade.takeProfit), inline: true }
          ],
          timestamp: new Date().toISOString()
        }]
      };
      
      try {
        await axios.post(this.discordWebhook, embed);
      } catch (err) {
        console.error('❌ Discord send failed:', err.message);
      }
    } else {
      const message = `
${emoji} *TRADE EXECUTED ON MT5*

*${trade.type}* ${trade.symbol}
*Price:* \`${this.formatPrice(trade.price)}\`
*Lot Size:* ${trade.lotSize}
*Ticket:* #${trade.ticket}

🛑 SL: \`${this.formatPrice(trade.stopLoss)}\`
🎯 TP: \`${this.formatPrice(trade.takeProfit)}\`

⏰ ${new Date().toLocaleString()}
      `;

      try {
        await axios.post(`https://api.telegram.org/bot${this.telegramToken}/sendMessage`, {
          chat_id: this.telegramChatId,
          text: message,
          parse_mode: 'Markdown'
        });
      } catch (err) {
        console.error('❌ Telegram send failed:', err.message);
      }
    }
  }

  async sendError(error) {
    if (!this.enabled) return;

    if (this.service === 'discord') {
      try {
        await axios.post(this.discordWebhook, {
          embeds: [{
            title: '❌ ERROR',
            description: error,
            color: 0xff0000,
            timestamp: new Date().toISOString()
          }]
        });
      } catch (err) {
        console.error('❌ Discord send failed:', err.message);
      }
    } else {
      const message = `❌ *ERROR*\n\n${error}\n\n⏰ ${new Date().toLocaleString()}`;
      try {
        await axios.post(`https://api.telegram.org/bot${this.telegramToken}/sendMessage`, {
          chat_id: this.telegramChatId,
          text: message,
          parse_mode: 'Markdown'
        });
      } catch (err) {
        console.error('❌ Telegram send failed:', err.message);
      }
    }
  }

  formatPrice(price) {
    if (price > 100) return price.toFixed(2);
    if (price > 10) return price.toFixed(3);
    return price.toFixed(5);
  }
}
