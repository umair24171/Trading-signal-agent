import axios from 'axios';

export class TelegramService {
  constructor() {
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

    this.retryCount = 3;
  }

  async sendWithRetry(fn, retries = 0) {
    try {
      await fn();
    } catch (err) {
      if (retries < this.retryCount) {
        await new Promise(r => setTimeout(r, 2000 * (retries + 1)));
        return this.sendWithRetry(fn, retries + 1);
      }
      console.error('❌ Notification send failed after retries:', err.message);
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
    const ctx = signal.context || {};
    const warnings = signal.warnings || [];

    const fields = [
      { name: '📊 Symbol', value: `\`${signal.symbol}\``, inline: true },
      { name: '💰 Entry Price', value: `\`${this.formatPrice(signal.price)}\``, inline: true },
      { name: '📈 Confidence', value: `**${signal.confidence}%**`, inline: true },
      { name: '🛑 Stop Loss', value: `\`${this.formatPrice(signal.stopLoss)}\``, inline: true },
      { name: '🎯 Take Profit', value: `\`${this.formatPrice(signal.takeProfit)}\``, inline: true },
      { name: '📊 Risk/Reward', value: `1:${signal.riskReward}`, inline: true },
      { name: '🔗 Confluence', value: `${signal.confluenceCount || 0} signals confirming`, inline: true },
      { name: '📈 Trend', value: `${ctx.trend || 'N/A'} (ADX: ${ctx.trendStrength?.toFixed(0) || 'N/A'})`, inline: true },
      { name: '🌍 Session', value: ctx.session || 'N/A', inline: true },
    ];

    // Add indicators
    fields.push({
      name: '📉 Indicators',
      value: [
        `RSI: ${signal.indicators.rsi || 'N/A'}`,
        `MACD: ${signal.indicators.macd || 'N/A'}`,
        `ADX: ${signal.indicators.adx || 'N/A'}`,
        `Stoch K: ${signal.indicators.stochK || 'N/A'}`,
        `CCI: ${signal.indicators.cci || 'N/A'}`
      ].join(' | '),
      inline: false
    });

    // Add reasons
    fields.push({
      name: '✅ Reasons',
      value: signal.reasons.map(r => `• ${r}`).join('\n') || 'N/A',
      inline: false
    });

    // Add warnings if any
    if (warnings.length > 0) {
      fields.push({
        name: '⚠️ Warnings',
        value: warnings.join('\n'),
        inline: false
      });
    }

    // S/R levels
    if (ctx.support && ctx.resistance) {
      fields.push({
        name: '📏 Key Levels',
        value: `Support: \`${this.formatPrice(ctx.support)}\` | Resistance: \`${this.formatPrice(ctx.resistance)}\``,
        inline: false
      });
    }

    // v6: Momentum info
    if (signal.momentum) {
      const mom = signal.momentum;
      const parts = [];
      if (mom.bullishCandles > 0) parts.push(`${mom.bullishCandles}🟢 candles`);
      if (mom.bearishCandles > 0) parts.push(`${mom.bearishCandles}🔴 candles`);
      if (mom.priceStructure !== 'NONE') parts.push(`Structure: ${mom.priceStructure}`);
      if (mom.isMomentumMove) parts.push(`🚀 Strong move (${mom.moveSize}x ATR)`);
      if (parts.length > 0) {
        fields.push({
          name: '💪 Momentum',
          value: parts.join(' | '),
          inline: false
        });
      }
    }

    const embed = {
      embeds: [{
        title: `${emoji} ${signal.action} SIGNAL — ${signal.symbol}`,
        color,
        fields,
        footer: {
          text: `⚠️ Not financial advice | Regime: ${ctx.regime || 'N/A'} | Vol: ${ctx.volatility || 'N/A'}`
        },
        timestamp: new Date().toISOString()
      }]
    };

    await this.sendWithRetry(async () => {
      await axios.post(this.discordWebhook, embed);
      console.log('📱 Signal sent to Discord');
    });
  }

  async sendTelegramSignal(signal) {
    const emoji = signal.action === 'BUY' ? '🟢' : '🔴';
    const ctx = signal.context || {};
    const warnings = signal.warnings || [];

    let message = `
${emoji} *${signal.action} SIGNAL* — \`${signal.symbol}\`

💰 *Entry:* \`${this.formatPrice(signal.price)}\`
📈 *Confidence:* ${signal.confidence}%
🔗 *Confluence:* ${signal.confluenceCount || 0} signals

🛑 *Stop Loss:* \`${this.formatPrice(signal.stopLoss)}\`
🎯 *Take Profit:* \`${this.formatPrice(signal.takeProfit)}\`
📊 *R/R:* 1:${signal.riskReward}

*Market Context:*
• Trend: ${ctx.trend || 'N/A'} (Strength: ${ctx.trendStrength?.toFixed(0) || 'N/A'})
• Regime: ${ctx.regime || 'N/A'}
• Session: ${ctx.session || 'N/A'}
• Volatility: ${ctx.volatility || 'N/A'}

*Indicators:*
• RSI: ${signal.indicators.rsi} | MACD: ${signal.indicators.macd}
• ADX: ${signal.indicators.adx} | Stoch: ${signal.indicators.stochK}

*Reasons:*
${signal.reasons.map(r => `✅ ${r}`).join('\n')}
${warnings.length > 0 ? '\n*Warnings:*\n' + warnings.map(w => `${w}`).join('\n') : ''}

⏰ ${new Date().toLocaleString()}
⚠️ _Not financial advice. Trade at your own risk._
    `;

    await this.sendWithRetry(async () => {
      await axios.post(`https://api.telegram.org/bot${this.telegramToken}/sendMessage`, {
        chat_id: this.telegramChatId,
        text: message,
        parse_mode: 'Markdown'
      });
      console.log('📱 Signal sent to Telegram');
    });
  }

  async sendMessage(text) {
    if (!this.enabled) return;

    if (this.service === 'discord') {
      await this.sendWithRetry(async () => {
        await axios.post(this.discordWebhook, { content: text.replace(/\*/g, '**').replace(/_/g, '*') });
      });
    } else {
      await this.sendWithRetry(async () => {
        await axios.post(`https://api.telegram.org/bot${this.telegramToken}/sendMessage`, {
          chat_id: this.telegramChatId,
          text,
          parse_mode: 'Markdown'
        });
      });
    }
  }

  async sendDailyReport(report) {
    if (!this.enabled) return;

    if (this.service === 'discord') {
      const embed = {
        embeds: [{
          title: '📊 Daily Trading Report',
          color: 0x3498db,
          fields: [
            { name: '📈 Signals Today', value: `${report.totalSignals}`, inline: true },
            { name: '🟢 Buy Signals', value: `${report.buySignals}`, inline: true },
            { name: '🔴 Sell Signals', value: `${report.sellSignals}`, inline: true },
            { name: '📊 Avg Confidence', value: `${report.avgConfidence}%`, inline: true },
            { name: '🌐 API Credits', value: `${report.apiCreditsUsed}/${report.apiDailyLimit}`, inline: true },
            { name: '💓 Uptime', value: `${report.uptime}`, inline: true }
          ],
          footer: { text: '🤖 Trading Signal Agent v2' },
          timestamp: new Date().toISOString()
        }]
      };

      await this.sendWithRetry(async () => {
        await axios.post(this.discordWebhook, embed);
      });
    } else {
      const message = `
📊 *Daily Trading Report*

📈 Signals: ${report.totalSignals} (🟢 ${report.buySignals} Buy | 🔴 ${report.sellSignals} Sell)
📊 Avg Confidence: ${report.avgConfidence}%
🌐 API Credits: ${report.apiCreditsUsed}/${report.apiDailyLimit}
💓 Uptime: ${report.uptime}

⏰ ${new Date().toLocaleString()}
      `;

      await this.sendWithRetry(async () => {
        await axios.post(`https://api.telegram.org/bot${this.telegramToken}/sendMessage`, {
          chat_id: this.telegramChatId,
          text: message,
          parse_mode: 'Markdown'
        });
      });
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
      
      await this.sendWithRetry(async () => {
        await axios.post(this.discordWebhook, embed);
      });
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

      await this.sendWithRetry(async () => {
        await axios.post(`https://api.telegram.org/bot${this.telegramToken}/sendMessage`, {
          chat_id: this.telegramChatId,
          text: message,
          parse_mode: 'Markdown'
        });
      });
    }
  }

  async sendError(error) {
    if (!this.enabled) return;

    if (this.service === 'discord') {
      await this.sendWithRetry(async () => {
        await axios.post(this.discordWebhook, {
          embeds: [{
            title: '❌ ERROR',
            description: error,
            color: 0xff0000,
            timestamp: new Date().toISOString()
          }]
        });
      });
    } else {
      await this.sendWithRetry(async () => {
        await axios.post(`https://api.telegram.org/bot${this.telegramToken}/sendMessage`, {
          chat_id: this.telegramChatId,
          text: `❌ *ERROR*\n\n${error}\n\n⏰ ${new Date().toLocaleString()}`,
          parse_mode: 'Markdown'
        });
      });
    }
  }

  formatPrice(price) {
    if (price > 100) return price.toFixed(2);
    if (price > 10) return price.toFixed(3);
    return price.toFixed(5);
  }
}