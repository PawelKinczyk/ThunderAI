/*
 *  ThunderAI [https://micz.it/thunderbird-addon-thunderai/]
 *  Copyright (C) 2024 - 2026  Mic (m@micz.it)

 *  This program is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation, either version 3 of the License, or
 *  (at your option) any later version.

 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.

 *  You should have received a copy of the GNU General Public License
 *  along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

import { placeholdersUtils } from './mzta-placeholders.js';
import {
    extractJsonObject,
    getMailInlineTextParts,
    htmlBodyToPlainText,
    cleanupNewlines,
    getTagsList
} from './mzta-utils.js';
import { getSpecialPrompts } from './mzta-prompts.js';
import { prefs_default } from '../options/mzta-options-default.js';
import { taLogger } from './mzta-logger.js';

export const taPromptUtils = {

    async getDefaultSignature(){
        let prefs = await browser.storage.sync.get({ default_sign_name: prefs_default.default_sign_name });
        if(prefs.default_sign_name===''){
            return '';
        }else{
            return browser.i18n.getMessage("sign_msg_as") + " " + prefs.default_sign_name + ".";
        }
    },

    async preparePrompt(args){
        const {
            curr_prompt = {},
            curr_message = {},
            chatgpt_lang = '',
            selection_text = '',
            selection_html = '',
            body_text = '',
            subject_text = '',
            msg_text = {},
            only_typed_text = '',
            only_quoted_text = '',
            tags_full_list = ["", []]
        } = args || {};

        let fullPrompt = '';
        
        if(!placeholdersUtils.hasPlaceholder(curr_prompt.text)){
            // no placeholders, do as usual
            const signature = String(curr_prompt.need_signature) === "1" ? await taPromptUtils.getDefaultSignature() : "";
            const content = selection_text || body_text;
            fullPrompt = [curr_prompt.text, signature, chatgpt_lang, content ? `"${content}"` : ""].filter(Boolean).join(" ");
        }else{
            // we have at least a placeholder, do the magic!
            // check if we have custom placeholders
            if(placeholdersUtils.hasCustomPlaceholder(curr_prompt.text)){
                curr_prompt.text = await placeholdersUtils.replaceCustomPlaceholders(curr_prompt.text);
            }
            
            // Replace all {%additional_text%} with {%additional_text:N%}
            let additionalTextCounter = 1;
            curr_prompt.text = curr_prompt.text.replace(/{%\s*additional_text\s*%}/g, () => {
                return `{%additional_text:#${additionalTextCounter++}%}`;
            });

            let finalSubs = await placeholdersUtils.getPlaceholdersValues({
                prompt_text: curr_prompt.text,
                curr_message: curr_message,
                mail_subject: subject_text,
                body_text: body_text,
                msg_text: msg_text,
                only_typed_text: only_typed_text,
                only_quoted_text: only_quoted_text,
                selection_text: selection_text,
                selection_html: selection_html,
                tags_full_list: tags_full_list
            });
            let prefs_ph = await browser.storage.sync.get({ placeholders_use_default_value: prefs_default.placeholders_use_default_value });
            fullPrompt = (placeholdersUtils.replacePlaceholders({
                text: curr_prompt.text,
                replacements: finalSubs,
                use_default_value: prefs_ph.placeholders_use_default_value,
                skip_additional_text: true
            }) + (String(curr_prompt.need_signature) == "1" ? " " + await taPromptUtils.getDefaultSignature():"") + " " + chatgpt_lang).trim();
        }

        return fullPrompt;
    },

    // Cuts a text to about maxChars characters, preferring a word boundary near the end.
    // Used to keep very long emails inside the context window of small (local) models.
    // maxChars <= 0 means no limit.
    truncateText(text, maxChars){
        if(!(maxChars > 0) || typeof text !== 'string' || text.length <= maxChars){
            return text;
        }
        let cutPos = text.lastIndexOf(' ', maxChars);
        if(cutPos < maxChars * 0.9){
            cutPos = maxChars;
        }
        return text.substring(0, cutPos).trimEnd() + ' [...]';
    },

    // Returns copies of the email content fields with every text truncated to maxChars.
    // The originals are left untouched: on the automatic path they are shared with the
    // other features (spamfilter, summarize, translate) processing the same message.
    limitMailContent({ body_text = '', selection_text = '', selection_html = '', msg_text = {} } = {}, maxChars = 0){
        const cut = (t) => taPromptUtils.truncateText(t, maxChars);
        let limited_msg_text = { ...msg_text };
        for (const key of ['text', 'html', 'plain_part', 'selection', 'selection_html']) {
            if (typeof limited_msg_text[key] === 'string') {
                limited_msg_text[key] = cut(limited_msg_text[key]);
            }
        }
        return {
            body_text: cut(body_text),
            selection_text: cut(selection_text),
            selection_html: cut(selection_html),
            msg_text: limited_msg_text
        };
    },

    finalizePrompt_add_tags(fullPrompt, add_tags_maxnum, add_tags_force_lang, default_chatgpt_lang, add_tags_auto_uselist = false, add_tags_auto_uselist_list = ''){
        if(add_tags_maxnum > 0){
            fullPrompt += " \n" + browser.i18n.getMessage("prompt_add_tags_maxnum") + " " + add_tags_maxnum +".";
        }
        if(add_tags_force_lang && default_chatgpt_lang !== ''){
            fullPrompt += " \n" + browser.i18n.getMessage("prompt_add_tags_force_lang") + " " + default_chatgpt_lang + ".";
        }
        if(add_tags_auto_uselist && add_tags_auto_uselist_list && add_tags_auto_uselist_list.length > 0){
            fullPrompt += " \n" + browser.i18n.getMessage("prompt_add_tags_use_list") + ": " + add_tags_auto_uselist_list + ".";
        }

        return fullPrompt;
    },

    finalizePrompt_get_calendar_event(fullPrompt){
        fullPrompt = fullPrompt.replace("{%cc_list%}", "");
        fullPrompt = fullPrompt.replace("{%recipients%}", "");

        return fullPrompt;
    },   

    async getDefaultLang(curr_prompt){
        let chatgpt_lang = '';
        if(String(curr_prompt?.define_response_lang) == "1"){
            let prefs = await browser.storage.sync.get({ default_chatgpt_lang: prefs_default.default_chatgpt_lang });
            chatgpt_lang = prefs.default_chatgpt_lang;
            if(chatgpt_lang === ''){
                chatgpt_lang = browser.i18n.getMessage("reply_same_lang");
            }else{
                chatgpt_lang = browser.i18n.getMessage("prompt_lang") + " " + chatgpt_lang + ".";
            }
        }

        return chatgpt_lang;
    },

    
    async buildSummaryPrompt(messageDataArray) {
        const specialPrompts = await getSpecialPrompts();
        const prompt = specialPrompts.find(p => p.id === 'prompt_summarize');
        const prompt_email = specialPrompts.find(p => p.id === 'prompt_summarize_email_template');
        const prompt_email_separator = specialPrompts.find(p => p.id === 'prompt_summarize_email_separator');

        const chatgpt_lang = await taPromptUtils.getDefaultLang(prompt);
        // Max characters of each email content sent to the AI (0 = no limit), so that long
        // emails still fit the context window of small (local) models.
        const prefs_limit = await browser.storage.sync.get({ summarize_max_body_chars: prefs_default.summarize_max_body_chars, do_debug: prefs_default.do_debug });
        const taLog = new taLogger('buildSummaryPrompt', prefs_limit.do_debug);
        // Fetched ONCE here, not per message: the tag list is global to Thunderbird and
        // every mail in the loop resolves {%tags_current_email%} against the same one.
        const tags_full_list = await getTagsList();

        const prompt_string = await taPromptUtils.preparePrompt({
            curr_prompt: prompt,
            chatgpt_lang: chatgpt_lang,
        });
        const prompt_email_separator_string = await taPromptUtils.preparePrompt({
            curr_prompt: prompt_email_separator,
            chatgpt_lang: chatgpt_lang,
        });

        const messages_list = [];
        for (let entry of messageDataArray) {
            // entry.message is REQUIRED: its .id is what reads the body now that
            // getMailInlineTextParts() asks the API directly, instead of walking the
            // fullMessage the caller used to supply. An entry carrying only
            // { fullMessage } - the shape this loop silently accepted before - would
            // sail past getMailInlineTextParts()'s own try/catch and summarize an EMPTY
            // body, with the subject still there so the result reads as plausible.
            // Say so instead of degrading in silence, and skip the entry rather than
            // contribute a bodyless block to the prompt.
            if (!entry?.message?.id) {
                console.error('[ThunderAI] buildSummaryPrompt: skipping an entry with no message.id - the body cannot be read without it. Entry:', entry);
                continue;
            }
            const bodyHtml = await getMailInlineTextParts(entry.message.id);
            let bodyText = htmlBodyToPlainText(bodyHtml.html);
            if (bodyText.length === 0) {
                bodyText = cleanupNewlines(bodyHtml.text || '');
            }
            const limited_content = taPromptUtils.limitMailContent({ body_text: bodyText, msg_text: bodyHtml }, prefs_limit.summarize_max_body_chars);
            if (limited_content.body_text !== bodyText) {
                taLog.log("Summarize: email content truncated to " + prefs_limit.summarize_max_body_chars + " characters (original length: " + bodyText.length + ").");
            }

            messages_list.push(await taPromptUtils.preparePrompt({
                curr_prompt: prompt_email,
                curr_message: entry.message,
                chatgpt_lang: chatgpt_lang,
                body_text: limited_content.body_text,
                subject_text: entry.fullMessage.headers.subject,
                msg_text: limited_content.msg_text,
                tags_full_list: tags_full_list,
            }));
        }

        const messages_string = messages_list.join(prompt_email_separator_string);
        const promptText = prompt_string + prompt_email_separator_string + messages_string;

        return { promptText, promptInfo: prompt };
    },

    // messageId is needed for the body: getMailInlineTextParts() asks the API for
    // the inline text parts directly. fullMessage stays for the subject header.
    async buildTranslationPrompt(fullMessage, messageId) {
        const specialPrompts = await getSpecialPrompts();
        const prompt = specialPrompts.find(p => p.id === 'prompt_translate_this');

        let promptText = prompt.text;
        if (promptText === 'prompt_translate_this_full_text') {
            promptText = browser.i18n.getMessage('prompt_translate_this_full_text');
        }

        // No messageId means no body: getMailInlineTextParts() would throw on an
        // undefined id and swallow it in its own try/catch, returning {text:'',html:''}.
        // The translation would then be built from the SUBJECT alone and cached as a
        // valid result - the failure is invisible downstream, so it is named here.
        if (!messageId) {
            console.error('[ThunderAI] buildTranslationPrompt: called with no messageId - the message body will be empty. The caller must pass it alongside fullMessage.');
        }

        const bodyHtml = await getMailInlineTextParts(messageId);
        const mailSubject = fullMessage.headers?.subject?.[0] || '';

        const finalSubs = await placeholdersUtils.getPlaceholdersValues({
            prompt_text: promptText,
            msg_text: { html: bodyHtml.html, text: bodyHtml.text },
            mail_subject: mailSubject,
        });

        const fullPrompt = placeholdersUtils.replacePlaceholders({
            text: promptText,
            replacements: finalSubs,
            use_default_value: false,
        });

        return { promptText: fullPrompt, promptInfo: prompt };
    },

    /**
     * Extracts tags from the response text.
     * @param {string} response_text - The response text from which to extract tags.
     * @returns {Array} An array of tags extracted from the response text.
     * 
     * The response text should be a JSON with this structure:
     * {
     *   "tags": ["tag1", "tag2", ...]
     * }
     * 
     * For backwords compatibility, if the response text is not a valid JSON,
     * it will try to split the text by commas and return the resulting array.
     */
    getTagsFromResponse(response_text, filter_tags = false, filter_tags_list = ''){
        let tags = [];
        if(response_text && response_text.length > 0){
            try {
                // Try to parse the response text as JSON
                let response_json = extractJsonObject(response_text.trim());
                if(response_json && Array.isArray(response_json.tags)){
                    tags = response_json.tags;
                } else if(response_json && response_json.tags && typeof response_json.tags === 'string'){
                    // If tags is a string, split it by commas
                    tags = response_json.tags.split(/,\s*/).map(tag => tag.trim());
                }
            } catch (e) {
                // If parsing fails, fallback to splitting by commas
                tags = response_text.split(/,\s*/).map(tag => tag.trim());
            }
        }
        if(filter_tags && filter_tags_list && filter_tags_list.length > 0){
            const allowedTags = filter_tags_list.split(',').map(tag => tag.trim().toLowerCase()).filter(tag => tag.length > 0);
            tags = tags.filter(tag => allowedTags.includes(tag.toLowerCase()));
        }
        return tags;
    }
};
