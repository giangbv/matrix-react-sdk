/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017, 2018 New Vector Ltd
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
import React from 'react';
import PropTypes from 'prop-types';

import { Editor } from 'slate-react';
import { getEventTransfer } from 'slate-react';
import { Value, Block, Inline, Range } from 'slate';
import type { Change } from 'slate';

import Html from 'slate-html-serializer';
import Md from 'slate-md-serializer';
import Plain from 'slate-plain-serializer';
import PlainWithPillsSerializer from "../../../autocomplete/PlainWithPillsSerializer";

import classNames from 'classnames';

import MatrixClientPeg from '../../../MatrixClientPeg';
import type {MatrixClient} from 'matrix-js-sdk/lib/matrix';
import {processCommandInput} from '../../../SlashCommands';
import { KeyCode, isOnlyCtrlOrCmdKeyEvent } from '../../../Keyboard';
import Modal from '../../../Modal';
import sdk from '../../../index';
import { _t } from '../../../languageHandler';
import Analytics from '../../../Analytics';

import dis from '../../../dispatcher';

import * as HtmlUtils from '../../../HtmlUtils';
import Autocomplete from './Autocomplete';
import {Completion} from "../../../autocomplete/Autocompleter";
import Markdown from '../../../Markdown';
import MessageComposerStore from '../../../stores/MessageComposerStore';
import ContentMessages from '../../../ContentMessages';

import {MATRIXTO_URL_PATTERN} from '../../../linkify-matrix';

import EMOJIBASE from 'emojibase-data/en/compact.json';
import EMOTICON_REGEX from 'emojibase-regex/emoticon';

import SettingsStore, {SettingLevel} from "../../../settings/SettingsStore";
import {makeUserPermalink} from "../../../matrix-to";
import ReplyPreview from "./ReplyPreview";
import RoomViewStore from '../../../stores/RoomViewStore';
import ReplyThread from "../elements/ReplyThread";
import {ContentHelpers} from 'matrix-js-sdk';
import AccessibleButton from '../elements/AccessibleButton';
import {findEditableEvent} from '../../../utils/EventUtils';
import ComposerHistoryManager from "../../../ComposerHistoryManager";
import TypingStore from "../../../stores/TypingStore";

const REGEX_EMOTICON_WHITESPACE = new RegExp('(?:^|\\s)(' + EMOTICON_REGEX.source + ')\\s$');

// the Slate node type to default to for unstyled text
const DEFAULT_NODE = 'paragraph';

// map HTML elements through to our Slate schema node types
// used for the HTML deserializer.
// (The names here are chosen to match the MD serializer's schema for convenience)
const BLOCK_TAGS = {
    p: 'paragraph',
    blockquote: 'block-quote',
    ul: 'bulleted-list',
    h1: 'heading1',
    h2: 'heading2',
    h3: 'heading3',
    h4: 'heading4',
    h5: 'heading5',
    h6: 'heading6',
    li: 'list-item',
    ol: 'numbered-list',
    pre: 'code',
};

const MARK_TAGS = {
    strong: 'bold',
    b: 'bold', // deprecated
    em: 'italic',
    i: 'italic', // deprecated
    code: 'code',
    u: 'underlined',
    del: 'deleted',
    strike: 'deleted', // deprecated
    s: 'deleted', // deprecated
};

const SLATE_SCHEMA = {
    inlines: {
        pill: {
            isVoid: true,
        },
        emoji: {
            isVoid: true,
        },
    },
};

function onSendMessageFailed(err, room) {
    // XXX: temporary logging to try to diagnose
    // https://github.com/vector-im/riot-web/issues/3148
    console.log('MessageComposer got send failure: ' + err.name + '('+err+')');
    dis.dispatch({
        action: 'message_send_failed',
    });
}

function rangeEquals(a: Range, b: Range): boolean {
    return (a.anchor.key === b.anchor.key
        && a.anchor.offset === b.anchorOffset
        && a.focus.key === b.focusKey
        && a.focus.offset === b.focusOffset
        && a.isFocused === b.isFocused
        && a.isBackward === b.isBackward);
}

/*
 * The textInput part of the MessageComposer
 */
export default class MessageComposerInput extends React.Component {
    static propTypes = {
        // js-sdk Room object
        room: PropTypes.object.isRequired,

        onInputStateChanged: PropTypes.func,
    };

    client: MatrixClient;
    autocomplete: Autocomplete;
    historyManager: ComposerHistoryManager;

    constructor(props, context) {
        super(props, context);

        const isRichTextEnabled = SettingsStore.getValue('MessageComposerInput.isRichTextEnabled');
        Analytics.setRichtextMode(isRichTextEnabled);

        this.client = MatrixClientPeg.get();

        // track whether we should be trying to show autocomplete suggestions on the current editor
        // contents. currently it's only suppressed when navigating history to avoid ugly flashes
        // of unexpected corrections as you navigate.
        // XXX: should this be in state?
        this.suppressAutoComplete = false;

        // track whether we've just pressed an arrowkey left or right in order to skip void nodes.
        // see https://github.com/ianstormtaylor/slate/issues/762#issuecomment-304855095
        this.direction = '';

        this.plainWithMdPills = new PlainWithPillsSerializer({ pillFormat: 'md' });
        this.plainWithIdPills = new PlainWithPillsSerializer({ pillFormat: 'id' });
        this.plainWithPlainPills = new PlainWithPillsSerializer({ pillFormat: 'plain' });

        this.md = new Md({
            rules: [
                {
                    // if serialize returns undefined it falls through to the default hardcoded
                    // serialization rules
                    serialize: (obj, children) => {
                        if (obj.object !== 'inline') return;
                        switch (obj.type) {
                            case 'pill':
                                return `[${ obj.data.get('completion') }](${ obj.data.get('href') })`;
                            case 'emoji':
                                return obj.data.get('emojiUnicode');
                        }
                    },
                }, {
                    serialize: (obj, children) => {
                        if (obj.object !== 'mark') return;
                        // XXX: slate-md-serializer consumes marks other than bold, italic, code, inserted, deleted
                        switch (obj.type) {
                            case 'underlined':
                                return `<u>${ children }</u>`;
                            case 'deleted':
                                return `<del>${ children }</del>`;
                            case 'code':
                                // XXX: we only ever get given `code` regardless of whether it was inline or block
                                // XXX: workaround for https://github.com/tommoor/slate-md-serializer/issues/14
                                // strip single backslashes from children, as they would have been escaped here
                                return `\`${ children.split('\\').map((v) => v ? v : '\\').join('') }\``;
                        }
                    },
                },
            ],
        });

        this.html = new Html({
            rules: [
                {
                    deserialize: (el, next) => {
                        const tag = el.tagName.toLowerCase();
                        let type = BLOCK_TAGS[tag];
                        if (type) {
                            return {
                                object: 'block',
                                type: type,
                                nodes: next(el.childNodes),
                            };
                        }
                        type = MARK_TAGS[tag];
                        if (type) {
                            return {
                                object: 'mark',
                                type: type,
                                nodes: next(el.childNodes),
                            };
                        }
                        // special case links
                        if (tag === 'a') {
                            const href = el.getAttribute('href');
                            let m;
                            if (href) {
                                m = href.match(MATRIXTO_URL_PATTERN);
                            }
                            if (m) {
                                return {
                                    object: 'inline',
                                    type: 'pill',
                                    data: {
                                        href,
                                        completion: el.innerText,
                                        completionId: m[1],
                                    },
                                };
                            } else {
                                return {
                                    object: 'inline',
                                    type: 'link',
                                    data: { href },
                                    nodes: next(el.childNodes),
                                };
                            }
                        }
                    },
                    serialize: (obj, children) => {
                        if (obj.object === 'block') {
                            return this.renderNode({
                                node: obj,
                                children: children,
                            });
                        } else if (obj.object === 'mark') {
                            return this.renderMark({
                                mark: obj,
                                children: children,
                            });
                        } else if (obj.object === 'inline') {
                            // special case links, pills and emoji otherwise we
                            // end up with React components getting rendered out(!)
                            switch (obj.type) {
                                case 'pill':
                                    return <a href={ obj.data.get('href') }>{ obj.data.get('completion') }</a>;
                                case 'link':
                                    return <a href={ obj.data.get('href') }>{ children }</a>;
                                case 'emoji':
                                    // XXX: apparently you can't return plain strings from serializer rules
                                    // until https://github.com/ianstormtaylor/slate/pull/1854 is merged.
                                    // So instead we temporarily wrap emoji from RTE in a span.
                                    return <span>{ obj.data.get('emojiUnicode') }</span>;
                            }
                            return this.renderNode({
                                node: obj,
                                children: children,
                            });
                        }
                    },
                },
            ],
        });

        const savedState = MessageComposerStore.getEditorState(this.props.room.roomId);
        this.state = {
            // whether we're in rich text or markdown mode
            isRichTextEnabled,

            // the currently displayed editor state (note: this is always what is modified on input)
            editorState: this.createEditorState(
                isRichTextEnabled,
                savedState ? savedState.editor_state : undefined,
                savedState ? savedState.rich_text : undefined,
            ),

            // the original editor state, before we started tabbing through completions
            originalEditorState: null,

            // the virtual state "above" the history stack, the message currently being composed that
            // we want to persist whilst browsing history
            currentlyComposedEditorState: null,

            // whether there were any completions
            someCompletions: null,
        };
    }

    /*
     * "Does the right thing" to create an Editor value, based on:
     * - whether we've got rich text mode enabled
     * - contentState was passed in
     * - whether the contentState that was passed in was rich text
     */
    createEditorState(wantRichText: boolean, editorState: ?Value, wasRichText: ?boolean): Value {
        if (editorState instanceof Value) {
            if (wantRichText && !wasRichText) {
                return this.mdToRichEditorState(editorState);
            }
            if (wasRichText && !wantRichText) {
                return this.richToMdEditorState(editorState);
            }
            return editorState;
        } else {
            // ...or create a new one. and explicitly focus it otherwise tab in-out issues
            const base = Plain.deserialize('', { defaultBlock: DEFAULT_NODE });
            return base.change().focus().value;
        }
    }

    componentWillMount() {
        this.dispatcherRef = dis.register(this.onAction);
        this.historyManager = new ComposerHistoryManager(this.props.room.roomId, 'mx_slate_composer_history_');
        this.enableRichtext(true)
    }

    componentWillUnmount() {
        dis.unregister(this.dispatcherRef);
    }

    _collectEditor = (e) => {
        this._editor = e;
    }

    onAction = (payload) => {
        const editorState = this.state.editorState;

        switch (payload.action) {
            case 'reply_to_event':
            case 'focus_composer':
                this.focusComposer();
                break;
            case 'insert_mention':
            {
                // Pretend that we've autocompleted this user because keeping two code
                // paths for inserting a user pill is not fun
                const selection = this.getSelectionRange(this.state.editorState);
                const member = this.props.room.getMember(payload.user_id);
                const completion = member ?
                    member.rawDisplayName : payload.user_id;
                this.setDisplayedCompletion({
                    completion,
                    completionId: payload.user_id,
                    selection,
                    href: makeUserPermalink(payload.user_id),
                    suffix: (selection.beginning && selection.start === 0) ? ': ' : ' ',
                });
            }
                break;
            case 'quote': {
                const html = HtmlUtils.bodyToHtml(payload.event.getContent(), null, {
                    forComposerQuote: true,
                    returnString: true,
                });
                const fragment = this.html.deserialize(html);
                // FIXME: do we want to put in a permalink to the original quote here?
                // If so, what should be the format, and how do we differentiate it from replies?

                const quote = Block.create('block-quote');
                if (this.state.isRichTextEnabled) {
                    let change = editorState.change();
                    const anchorText = editorState.anchorText;
                    if ((!anchorText || anchorText.text === '') && editorState.anchorBlock.nodes.size === 1) {
                        // replace the current block rather than split the block
                        // XXX: this destroys our focus by deleting the thing we are anchored/focused on
                        change = change.replaceNodeByKey(editorState.anchorBlock.key, quote);
                    } else {
                        // insert it into the middle of the block (splitting it)
                        change = change.insertBlock(quote);
                    }

                    // XXX: heuristic to strip out wrapping <p> which breaks quoting in RT mode
                    if (fragment.document.nodes.size && fragment.document.nodes.get(0).type === DEFAULT_NODE) {
                        change = change.insertFragmentByKey(quote.key, 0, fragment.document.nodes.get(0));
                    } else {
                        change = change.insertFragmentByKey(quote.key, 0, fragment.document);
                    }

                    // XXX: this is to bring back the focus in a sane place and add a paragraph after it
                    change = change.select(Range.create({
                        anchor: {
                            key: quote.key,
                        },
                        focus: {
                            key: quote.key,
                        },
                    })).moveToEndOfBlock().insertBlock(Block.create(DEFAULT_NODE)).focus();

                    this.onChange(change);
                } else {
                    const fragmentChange = fragment.change();
                    fragmentChange.moveToRangeOfNode(fragment.document)
                        .wrapBlock(quote);

                    // FIXME: handle pills and use commonmark rather than md-serialize
                    const md = this.md.serialize(fragmentChange.value);
                    const change = editorState.change()
                        .insertText(md + '\n\n')
                        .focus();
                    this.onChange(change);
                }
            }
                break;
        }
    };

    onChange = (change: Change, originalEditorState?: Value) => {
    let editorState = change.value;

    if (this.direction !== '') {
    const focusedNode = editorState.focusInline || editorState.focusText;
    if (editorState.schema.isVoid(focusedNode)) {
    // XXX: does this work in RTL?
    const edge = this.direction === 'Previous' ? 'End' : 'Start';
    if (editorState.selection.isCollapsed) {
    change = change[`moveTo${ edge }Of${ this.direction }Text`]();
} else {
    const block = this.direction === 'Previous' ? editorState.previousText : editorState.nextText;
    if (block) {
        change = change[`moveFocusTo${ edge }OfNode`](block);
    }
}
editorState = change.value;
}
}

// when in autocomplete mode and selection changes hide the autocomplete.
// Selection changes when we enter text so use a heuristic to compare documents without doing it recursively
if (this.autocomplete.state.completionList.length > 0 && !this.autocomplete.state.hide &&
    !rangeEquals(this.state.editorState.selection, editorState.selection) &&
    // XXX: the heuristic failed when inlines like pills weren't taken into account. This is inideal
    this.state.editorState.document.toJSON() === editorState.document.toJSON()) {
    this.autocomplete.hide();
}

if (Plain.serialize(editorState) !== '') {
    TypingStore.sharedInstance().setSelfTyping(this.props.room.roomId, true);
} else {
    TypingStore.sharedInstance().setSelfTyping(this.props.room.roomId, false);
}

if (editorState.startText !== null) {
    const text = editorState.startText.text;
    const currentStartOffset = editorState.selection.start.offset;

    // Automatic replacement of plaintext emoji to Unicode emoji
    if (SettingsStore.getValue('MessageComposerInput.autoReplaceEmoji')) {
        // The first matched group includes just the matched plaintext emoji
        const emoticonMatch = REGEX_EMOTICON_WHITESPACE.exec(text.slice(0, currentStartOffset));
        if (emoticonMatch) {
            const query = emoticonMatch[1].toLowerCase().replace("-", "");
            const data = EMOJIBASE.find(e => e.emoticon ? e.emoticon.toLowerCase() === query : false);

            // only perform replacement if we found a match, otherwise we would be not letting user type
            if (data) {
                const range = Range.create({
                    anchor: {
                        key: editorState.startText.key,
                        offset: currentStartOffset - emoticonMatch[1].length - 1,
                    },
                    focus: {
                        key: editorState.startText.key,
                        offset: currentStartOffset - 1,
                    },
                });
                change = change.insertTextAtRange(range, data.unicode);
                editorState = change.value;
            }
        }
    }
}

if (this.props.onInputStateChanged && editorState.blocks.size > 0) {
    let blockType = editorState.blocks.first().type;
    // console.log("onInputStateChanged; current block type is " + blockType + " and marks are " + editorState.activeMarks);

    if (blockType === 'list-item') {
        const parent = editorState.document.getParent(editorState.blocks.first().key);
        if (parent.type === 'numbered-list') {
            blockType = 'numbered-list';
        } else if (parent.type === 'bulleted-list') {
            blockType = 'bulleted-list';
        }
    }
    const inputState = {
        marks: editorState.activeMarks,
        blockType,
    };
    this.props.onInputStateChanged(inputState);
}

// Record the editor state for this room so that it can be retrieved after switching to another room and back
MessageComposerStore.setEditorState(this.props.room.roomId, editorState, this.state.isRichTextEnabled);

this.setState({
    editorState,
    originalEditorState: originalEditorState || null,
});
};

mdToRichEditorState(editorState: Value): Value {
    // for consistency when roundtripping, we could use slate-md-serializer rather than
    // commonmark, but then we would lose pills as the MD deserialiser doesn't know about
    // them and doesn't have any extensibility hooks.
    //
    // The code looks like this:
    //
    // const markdown = this.plainWithMdPills.serialize(editorState);
    //
    // // weirdly, the Md serializer can't deserialize '' to a valid Value...
    // if (markdown !== '') {
    //     editorState = this.md.deserialize(markdown);
    // }
    // else {
    //     editorState = Plain.deserialize('', { defaultBlock: DEFAULT_NODE });
    // }

    // so, instead, we use commonmark proper (which is arguably more logical to the user
    // anyway, as they'll expect the RTE view to match what they'll see in the timeline,
    // but the HTML->MD conversion is anyone's guess).

    const textWithMdPills = this.plainWithMdPills.serialize(editorState);
    const markdown = new Markdown(textWithMdPills);
    // HTML deserialize has custom rules to turn matrix.to links into pill objects.
    return this.html.deserialize(markdown.toHTML());
}

richToMdEditorState(editorState: Value): Value {
    // FIXME: this conversion loses pills (turning them into pure MD links).
    // We need to add a pill-aware deserialize method
    // to PlainWithPillsSerializer which recognises pills in raw MD and turns them into pills.
    return Plain.deserialize(
        // FIXME: we compile the MD out of the RTE state using slate-md-serializer
        // which doesn't roundtrip symmetrically with commonmark, which we use for
        // compiling MD out of the MD editor state above.
        this.md.serialize(editorState),
        { defaultBlock: DEFAULT_NODE },
    );
}

enableRichtext(enabled: boolean) {
    if (enabled === this.state.isRichTextEnabled) return;

    Analytics.setRichtextMode(enabled);

    this.setState({
        editorState: this.createEditorState(
            enabled,
            this.state.editorState,
            this.state.isRichTextEnabled,
        ),
        isRichTextEnabled: enabled,
    }, () => {
        this._editor.focus();
        if (this.props.onInputStateChanged) {
            this.props.onInputStateChanged({
                isRichTextEnabled: enabled,
            });
        }
    });

    SettingsStore.setValue("MessageComposerInput.isRichTextEnabled", null, SettingLevel.ACCOUNT, enabled);
}

/**
 * Check if the current selection has a mark with `type` in it.
 *
 * @param {String} type
 * @return {Boolean}
 */

hasMark = type => {
    const { editorState } = this.state;
    return editorState.activeMarks.some(mark => mark.type === type);
};

/**
 * Check if the any of the currently selected blocks are of `type`.
 *
 * @param {String} type
 * @return {Boolean}
 */

hasBlock = type => {
    const { editorState } = this.state;
    return editorState.blocks.some(node => node.type === type);
};

onKeyDown = (ev: KeyboardEvent, change: Change, editor: Editor) => {
    this.suppressAutoComplete = false;
    this.direction = '';

    // Navigate autocomplete list with arrow keys
    if (this.autocomplete.countCompletions() > 0) {
        if (!(ev.ctrlKey || ev.shiftKey || ev.altKey || ev.metaKey)) {
            switch (ev.keyCode) {
                case KeyCode.UP:
                    this.autocomplete.moveSelection(-1);
                    ev.preventDefault();
                    return true;
                case KeyCode.DOWN:
                    this.autocomplete.moveSelection(+1);
                    ev.preventDefault();
                    return true;
            }
        }
    }

    // skip void nodes - see
    // https://github.com/ianstormtaylor/slate/issues/762#issuecomment-304855095
    if (ev.keyCode === KeyCode.LEFT) {
        this.direction = 'Previous';
    } else if (ev.keyCode === KeyCode.RIGHT) {
        this.direction = 'Next';
    }

    switch (ev.keyCode) {
        case KeyCode.ENTER:
            return this.handleReturn(ev, change);
        case KeyCode.BACKSPACE:
            return this.onBackspace(ev, change);
        case KeyCode.UP:
            return this.onVerticalArrow(ev, true);
        case KeyCode.DOWN:
            return this.onVerticalArrow(ev, false);
        case KeyCode.TAB:
            return this.onTab(ev);
        case KeyCode.ESCAPE:
            return this.onEscape(ev);
        case KeyCode.SPACE:
            return this.onSpace(ev, change);
    }

    if (isOnlyCtrlOrCmdKeyEvent(ev)) {
        const ctrlCmdCommand = {
            // C-m => Toggles between rich text and markdown modes
            [KeyCode.KEY_M]: 'toggle-mode',
            [KeyCode.KEY_B]: 'bold',
            [KeyCode.KEY_I]: 'italic',
            [KeyCode.KEY_U]: 'underlined',
            [KeyCode.KEY_J]: 'inline-code',
        }[ev.keyCode];
    }
};

onSpace = (ev: KeyboardEvent, change: Change): Change => {
    if (ev.metaKey || ev.altKey || ev.shiftKey || ev.ctrlKey) {
        return;
    }

    // drop a point in history so the user can undo a word
    // XXX: this seems nasty but adding to history manually seems a no-go
    ev.preventDefault();
    return change.withoutMerging(() => {
        change.insertText(ev.key);
    });
};

onBackspace = (ev: KeyboardEvent, change: Change): Change => {
    if (ev.metaKey || ev.altKey || ev.shiftKey) {
        return;
    }

    const { editorState } = this.state;

    // Allow Ctrl/Cmd-Backspace when focus starts at the start of the composer (e.g select-all)
    // for some reason if slate sees you Ctrl-backspace and your anchor.offset=0 it just resets your focus
    // XXX: Doing this now seems to put slate into a broken state, and it didn't appear to be doing
    // what it claims to do on the old version of slate anyway...
    /*if (!editorState.isCollapsed && editorState.selection.anchor.offset === 0) {
        return change.delete();
    }*/

    if (this.state.isRichTextEnabled) {
        // let backspace exit lists
        const isList = this.hasBlock('list-item');

        if (isList && editorState.selection.anchor.offset == 0) {
            change
                .setBlocks(DEFAULT_NODE)
                .unwrapBlock('bulleted-list')
                .unwrapBlock('numbered-list');
            return change;
        } else if (editorState.selection.anchor.offset == 0 && editorState.isCollapsed) {
            // turn blocks back into paragraphs
            if ((this.hasBlock('block-quote') ||
                this.hasBlock('heading1') ||
                this.hasBlock('heading2') ||
                this.hasBlock('heading3') ||
                this.hasBlock('heading4') ||
                this.hasBlock('heading5') ||
                this.hasBlock('heading6') ||
                this.hasBlock('code'))) {
                return change.setBlocks(DEFAULT_NODE);
            }

            // remove paragraphs entirely if they're nested
            const parent = editorState.document.getParent(editorState.anchorBlock.key);
            if (editorState.selection.anchor.offset == 0 &&
                this.hasBlock('paragraph') &&
                parent.nodes.size == 1 &&
                parent.object !== 'document') {
                return change.replaceNodeByKey(editorState.anchorBlock.key, editorState.anchorText)
                    .moveToEndOfNode(parent)
                    .focus();
            }
        }
    }
    return;
};

onPaste = (event: Event, change: Change, editor: Editor): Change => {
    const transfer = getEventTransfer(event);

    switch (transfer.type) {
        case 'files':
            // This actually not so much for 'files' as such (at time of writing
            // neither chrome nor firefox let you paste a plain file copied
            // from Finder) but more images copied from a different website
            // / word processor etc.
            return ContentMessages.sharedInstance().sendContentListToRoom(
                transfer.files, this.props.room.roomId, this.client,
            );
        case 'html': {
            if (this.state.isRichTextEnabled) {
                // FIXME: https://github.com/ianstormtaylor/slate/issues/1497 means
                // that we will silently discard nested blocks (e.g. nested lists) :(
                const fragment = this.html.deserialize(transfer.html);
                return change
                // XXX: this somehow makes Slate barf on undo and get too empty and break entirely
                // .setOperationFlag("skip", false)
                // .setOperationFlag("merge", false)
                    .insertFragment(fragment.document);
            } else {
                // in MD mode we don't want the rich content pasted as the magic was annoying people so paste plain
                return change.withoutMerging(() => {
                    change.insertText(transfer.text);
                });
            }
        }
        case 'text':
            // don't skip/merge so that multiple consecutive pastes can be undone individually
            return change.withoutMerging(() => {
                change.insertText(transfer.text);
            });
    }
};

handleReturn = (ev, change) => {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    if (ev.shiftKey || (isMac && ev.altKey)) {
        return change.insertText('\n');
    }

    if (this.autocomplete.hasSelection()) {
        this.autocomplete.hide();
        ev.preventDefault();
        return true;
    }

    const editorState = this.state.editorState;

    const lastBlock = editorState.blocks.last();
    if (['code', 'block-quote', 'list-item'].includes(lastBlock.type)) {
        const text = lastBlock.text;
        if (text === '') {
            // allow the user to cancel empty block by hitting return, useful in conjunction with below `inBlock`
            return change
                .setBlocks(DEFAULT_NODE)
                .unwrapBlock('bulleted-list')
                .unwrapBlock('numbered-list');
        }

        // TODO strip trailing lines from blockquotes/list entries
        // the below code seemingly works but doesn't account for edge cases like return with caret not at end
        /* const trailingNewlines = text.match(/\n*$/);
        if (trailingNewlines && trailingNewlines[0]) {
            remove trailing newlines at the end of this block before making a new one
            return change.deleteBackward(trailingNewlines[0].length);
        }*/

        return;
    }

    let contentText;
    let contentHTML;

    // only look for commands if the first block contains simple unformatted text
    // i.e. no pills or rich-text formatting and begins with a /.
    let cmd; let commandText;
    const firstChild = editorState.document.nodes.get(0);
    const firstGrandChild = firstChild && firstChild.nodes.get(0);
    if (firstChild && firstGrandChild &&
        firstChild.object === 'block' && firstGrandChild.object === 'text' &&
        firstGrandChild.text[0] === '/') {
        commandText = this.plainWithIdPills.serialize(editorState);
        cmd = processCommandInput(this.props.room.roomId, commandText);
    }

    if (cmd) {
        if (!cmd.error) {
            this.historyManager.save(editorState, this.state.isRichTextEnabled ? 'rich' : 'markdown');
            this.setState({
                editorState: this.createEditorState(),
            }, ()=>{
                this._editor.focus();
            });
        }
        if (cmd.promise) {
            cmd.promise.then(()=>{
                console.log("Command success.");
            }, (err)=>{
                console.error("Command failure: %s", err);
                const ErrorDialog = sdk.getComponent("dialogs.ErrorDialog");
                Modal.createTrackedDialog('Server error', '', ErrorDialog, {
                    title: _t("Server error"),
                    description: ((err && err.message) ? err.message : _t(
                        "Server unavailable, overloaded, or something else went wrong.",
                    )),
                });
            });
        } else if (cmd.error) {
            console.error(cmd.error);
            const ErrorDialog = sdk.getComponent("dialogs.ErrorDialog");
            // TODO possibly track which command they ran (not its Arguments) here
            Modal.createTrackedDialog('Command error', '', ErrorDialog, {
                title: _t("Command error"),
                description: cmd.error,
            });
        }
        return true;
    }

    const replyingToEv = RoomViewStore.getQuotingEvent();
    const mustSendHTML = Boolean(replyingToEv);

    if (this.state.isRichTextEnabled) {
        // We should only send HTML if any block is styled or contains inline style
        let shouldSendHTML = false;

        if (mustSendHTML) shouldSendHTML = true;

        if (!shouldSendHTML) {
            shouldSendHTML = !!editorState.document.findDescendant(node => {
                // N.B. node.getMarks() might be private?
                return ((node.object === 'block' && node.type !== 'paragraph') ||
                    (node.object === 'inline') ||
                    (node.object === 'text' && node.getMarks().size > 0));
            });
        }

        contentText = this.plainWithPlainPills.serialize(editorState);
        if (contentText === '') return true;

        if (shouldSendHTML) {
            contentHTML = HtmlUtils.processHtmlForSending(this.html.serialize(editorState));
        }
    } else {
        const sourceWithPills = this.plainWithMdPills.serialize(editorState);
        if (sourceWithPills === '') return true;

        const mdWithPills = new Markdown(sourceWithPills);

        // if contains no HTML and we're not quoting (needing HTML)
        if (mdWithPills.isPlainText() && !mustSendHTML) {
            // N.B. toPlainText is only usable here because we know that the MD
            // didn't contain any formatting in the first place...
            contentText = mdWithPills.toPlaintext();
        } else {
            // to avoid ugliness on clients which ignore the HTML body we don't
            // send pills in the plaintext body.
            contentText = this.plainWithPlainPills.serialize(editorState);
            contentHTML = mdWithPills.toHTML();
        }
    }

    let sendHtmlFn = ContentHelpers.makeHtmlMessage;
    let sendTextFn = ContentHelpers.makeTextMessage;

    this.historyManager.save(editorState, this.state.isRichTextEnabled ? 'rich' : 'markdown');

    if (commandText && commandText.startsWith('/me')) {
        if (replyingToEv) {
            const ErrorDialog = sdk.getComponent("dialogs.ErrorDialog");
            Modal.createTrackedDialog('Emote Reply Fail', '', ErrorDialog, {
                title: _t("Unable to reply"),
                description: _t("At this time it is not possible to reply with an emote."),
            });
            return false;
        }

        contentText = contentText.substring(4);
        // bit of a hack, but the alternative would be quite complicated
        if (contentHTML) contentHTML = contentHTML.replace(/\/me ?/, '');
        sendHtmlFn = ContentHelpers.makeHtmlEmote;
        sendTextFn = ContentHelpers.makeEmoteMessage;
    }

    let content = contentHTML ?
        sendHtmlFn(contentText, contentHTML) :
        sendTextFn(contentText);

    if (replyingToEv) {
        const replyContent = ReplyThread.makeReplyMixIn(replyingToEv);
        content = Object.assign(replyContent, content);

        // Part of Replies fallback support - prepend the text we're sending
        // with the text we're replying to
        const nestedReply = ReplyThread.getNestedReplyText(replyingToEv, this.props.permalinkCreator);
        if (nestedReply) {
            if (content.formatted_body) {
                content.formatted_body = nestedReply.html + content.formatted_body;
            }
            content.body = nestedReply.body + content.body;
        }

        // Clear reply_to_event as we put the message into the queue
        // if the send fails, retry will handle resending.
        dis.dispatch({
            action: 'reply_to_event',
            event: null,
        });
    }

    this.client.sendMessage(this.props.room.roomId, content).then((res) => {
        dis.dispatch({
            action: 'message_sent',
        });
    }).catch((e) => {
        if (e.name === 'UnknownDeviceError') {
            console.log('resend');
        }
        onSendMessageFailed(e, this.props.room);
    });

    this.setState({
        editorState: this.createEditorState(),
    }, ()=>{ this._editor.focus(); });

    return true;
};

onVerticalArrow = (e, up) => {
    if (e.ctrlKey || e.shiftKey || e.metaKey) return;

    // selection must be collapsed
    const selection = this.state.editorState.selection;
    if (!selection.isCollapsed) return;
    // and we must be at the edge of the document (up=start, down=end)
    const document = this.state.editorState.document;
    if (up) {
        if (!selection.anchor.isAtStartOfNode(document)) return;
    } else {
        if (!selection.anchor.isAtEndOfNode(document)) return;
    }

    const shouldSelectHistory = e.altKey;
    const shouldEditLastMessage = !e.altKey && up && !RoomViewStore.getQuotingEvent();

    if (shouldSelectHistory) {
        // Try select composer history
        const selected = this.selectHistory(up);
        if (selected) {
            // We're selecting history, so prevent the key event from doing anything else
            e.preventDefault();
        }
    } else if (shouldEditLastMessage) {
        const editEvent = findEditableEvent(this.props.room, false);
        if (editEvent) {
            // We're selecting history, so prevent the key event from doing anything else
            e.preventDefault();
            dis.dispatch({
                action: 'edit_event',
                event: editEvent,
            });
        }
    }
};

selectHistory = (up) => {
    const delta = up ? -1 : 1;

    // True if we are not currently selecting history, but composing a message
    if (this.historyManager.currentIndex === this.historyManager.history.length) {
        // We can't go any further - there isn't any more history, so nop.
        if (!up) {
            return;
        }
        this.setState({
            currentlyComposedEditorState: this.state.editorState,
        });
    } else if (this.historyManager.currentIndex + delta === this.historyManager.history.length) {
        // True when we return to the message being composed currently
        this.setState({
            editorState: this.state.currentlyComposedEditorState,
        });
        this.historyManager.currentIndex = this.historyManager.history.length;
        return;
    }

    let editorState;
    const historyItem = this.historyManager.getItem(delta);
    if (!historyItem) return;

    if (historyItem.format === 'rich' && !this.state.isRichTextEnabled) {
        editorState = this.richToMdEditorState(historyItem.value);
    } else if (historyItem.format === 'markdown' && this.state.isRichTextEnabled) {
        editorState = this.mdToRichEditorState(historyItem.value);
    } else {
        editorState = historyItem.value;
    }

    // Move selection to the end of the selected history
    const change = editorState.change().moveToEndOfNode(editorState.document);

    // We don't call this.onChange(change) now, as fixups on stuff like pills
    // should already have been done and persisted in the history.
    editorState = change.value;

    this.suppressAutoComplete = true;

    this.setState({ editorState }, ()=>{
        this._editor.focus();
    });
    return true;
};

onTab = async (e) => {
    this.setState({
        someCompletions: null,
    });
    e.preventDefault();
    if (this.autocomplete.countCompletions() === 0) {
        // Force completions to show for the text currently entered
        const completionCount = await this.autocomplete.forceComplete();
        this.setState({
            someCompletions: completionCount > 0,
        });
        // Select the first item by moving "down"
        await this.autocomplete.moveSelection(+1);
    } else {
        await this.autocomplete.moveSelection(e.shiftKey ? -1 : +1);
    }
};

onEscape = async (e) => {
    e.preventDefault();
    if (this.autocomplete) {
        this.autocomplete.onEscape(e);
    }
    await this.setDisplayedCompletion(null); // restore originalEditorState
};

onAutocompleteConfirm = (displayedCompletion: ?Completion) => {
    this.focusComposer();
    // XXX: this fails if the composer isn't focused so focus it and delay the completion until next tick
    setImmediate(() => {
        this.setDisplayedCompletion(displayedCompletion);
    });
};

/* If passed null, restores the original editor content from state.originalEditorState.
 * If passed a non-null displayedCompletion, modifies state.originalEditorState to compute new state.editorState.
 */
setDisplayedCompletion = async (displayedCompletion: ?Completion): boolean => {
    const activeEditorState = this.state.originalEditorState || this.state.editorState;

    if (displayedCompletion == null) {
        if (this.state.originalEditorState) {
            const editorState = this.state.originalEditorState;
            this.setState({editorState});
        }
        return false;
    }

    const {
        range = null,
        completion = '',
        completionId = '',
        href = null,
        suffix = '',
    } = displayedCompletion;

    let inline;
    if (href) {
        inline = Inline.create({
            type: 'pill',
            data: { completion, completionId, href },
        });
    } else if (completion === '@room') {
        inline = Inline.create({
            type: 'pill',
            data: { completion, completionId },
        });
    }

    let editorState = activeEditorState;

    if (range) {
        const change = editorState.change()
            .moveToAnchor()
            .moveAnchorTo(range.start)
            .moveFocusTo(range.end)
            .focus();
        editorState = change.value;
    }

    let change;
    if (inline) {
        change = editorState.change()
            .insertInlineAtRange(editorState.selection, inline)
            .insertText(suffix)
            .focus();
    } else {
        change = editorState.change()
            .insertTextAtRange(editorState.selection, completion)
            .insertText(suffix)
            .focus();
    }
    // for good hygiene, keep editorState updated to track the result of the change
    // even though we don't do anything subsequently with it
    this.onChange(change, activeEditorState);

    return true;
};

renderNode = props => {
    const { attributes, children, node, isSelected } = props;

    switch (node.type) {
        case 'paragraph':
            return <p {...attributes}>{children}</p>;
        case 'block-quote':
            return <blockquote {...attributes}>{children}</blockquote>;
        case 'bulleted-list':
            return <ul {...attributes}>{children}</ul>;
        case 'heading1':
            return <h1 {...attributes}>{children}</h1>;
        case 'heading2':
            return <h2 {...attributes}>{children}</h2>;
        case 'heading3':
            return <h3 {...attributes}>{children}</h3>;
        case 'heading4':
            return <h4 {...attributes}>{children}</h4>;
        case 'heading5':
            return <h5 {...attributes}>{children}</h5>;
        case 'heading6':
            return <h6 {...attributes}>{children}</h6>;
        case 'list-item':
            return <li {...attributes}>{children}</li>;
        case 'numbered-list':
            return <ol {...attributes}>{children}</ol>;
        case 'code':
            return <pre {...attributes}>{children}</pre>;
        case 'link':
            return <a {...attributes} href={ node.data.get('href') }>{children}</a>;
        case 'pill': {
            const { data } = node;
            const url = data.get('href');
            const completion = data.get('completion');

            const shouldShowPillAvatar = SettingsStore.getValue("Pill.shouldShowPillAvatar");
            const Pill = sdk.getComponent('elements.Pill');

            if (completion === '@room') {
                return <Pill
                    type={Pill.TYPE_AT_ROOM_MENTION}
                    room={this.props.room}
                    shouldShowPillAvatar={shouldShowPillAvatar}
                    isSelected={isSelected}
                    {...attributes}
                />;
            } else if (Pill.isPillUrl(url)) {
                return <Pill
                    url={url}
                    room={this.props.room}
                    shouldShowPillAvatar={shouldShowPillAvatar}
                    isSelected={isSelected}
                    {...attributes}
                />;
            } else {
                const { text } = node;
                return <a href={url} {...props.attributes}>
                    { text }
                </a>;
            }
        }
        case 'emoji': {
            const { data } = node;
            return data.get('emojiUnicode');
        }
    }
};

renderMark = props => {
    const { children, mark, attributes } = props;
    switch (mark.type) {
        case 'bold':
            return <strong {...attributes}>{children}</strong>;
        case 'italic':
            return <em {...attributes}>{children}</em>;
        case 'code':
            return <code {...attributes}>{children}</code>;
        case 'underlined':
            return <u {...attributes}>{children}</u>;
        case 'deleted':
            return <del {...attributes}>{children}</del>;
    }
};

getAutocompleteQuery(editorState: Value) {
    // We can just return the current block where the selection begins, which
    // should be enough to capture any autocompletion input, given autocompletion
    // providers only search for the first match which intersects with the current selection.
    // This avoids us having to serialize the whole thing to plaintext and convert
    // selection offsets in & out of the plaintext domain.

    if (editorState.selection.anchor.key) {
        return editorState.document.getDescendant(editorState.selection.anchor.key).text;
    } else {
        return '';
    }
}

getSelectionRange(editorState: Value) {
    let beginning = false;
    const firstChild = editorState.document.nodes.get(0);
    const firstGrandChild = firstChild && firstChild.nodes.get(0);
    beginning = (firstChild && firstGrandChild &&
        firstChild.object === 'block' && firstGrandChild.object === 'text' &&
        editorState.selection.anchor.key === firstGrandChild.key);

    // return a character range suitable for handing to an autocomplete provider.
    // the range is relative to the anchor of the current editor selection.
    // if the selection spans multiple blocks, then we collapse it for the calculation.
    const range = {
        beginning, // whether the selection is in the first block of the editor or not
        start: editorState.selection.anchor.offset,
        end: (editorState.selection.anchor.key == editorState.selection.focus.key) ?
            editorState.selection.focus.offset : editorState.selection.anchor.offset,
    };
    if (range.start > range.end) {
        const tmp = range.start;
        range.start = range.end;
        range.end = tmp;
    }
    return range;
}

focusComposer = () => {
    this._editor.focus();
};

render() {
    const activeEditorState = this.state.originalEditorState || this.state.editorState;

    const className = classNames('mx_MessageComposer_input', {
        mx_MessageComposer_input_error: this.state.someCompletions === false,
    });

    const isEmpty = Plain.serialize(this.state.editorState) === '';

    let {placeholder} = this.props;
    // XXX: workaround for placeholder being shown when there is a formatting block e.g blockquote but no text
    if (isEmpty && this.state.editorState.startBlock && this.state.editorState.startBlock.type !== DEFAULT_NODE) {
        placeholder = undefined;
    }

    return (
        <div className="mx_MessageComposer_input_wrapper" onClick={this.focusComposer}>
            <div className="mx_MessageComposer_autocomplete_wrapper">
                <ReplyPreview permalinkCreator={this.props.permalinkCreator} />
                <Autocomplete
                    ref={(e) => this.autocomplete = e}
                    room={this.props.room}
                    onConfirm={this.onAutocompleteConfirm}
                    onSelectionChange={this.setDisplayedCompletion}
                    query={ this.suppressAutoComplete ? '' : this.getAutocompleteQuery(activeEditorState) }
                    selection={this.getSelectionRange(activeEditorState)}
                />
            </div>
            <div className={className}>
                <Editor ref={this._collectEditor}
                        dir="auto"
                        className="mx_MessageComposer_editor"
                        placeholder={placeholder}
                        value={this.state.editorState}
                        onChange={this.onChange}
                        onKeyDown={this.onKeyDown}
                        onPaste={this.onPaste}
                        renderNode={this.renderNode}
                        renderMark={this.renderMark}
                    // disable spell check for the placeholder because browsers don't like "unencrypted"
                        spellCheck={!isEmpty}
                        schema={SLATE_SCHEMA}
                />
            </div>
        </div>
    );
}
}
