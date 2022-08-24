import { babelTransformExpression } from '../../helpers/babel-transform';
import { fastClone } from '../../helpers/fast-clone';
import { collectCss } from '../../helpers/styles/collect-css';
import { checkIsCodeValue, MitosisComponent } from '../../types/mitosis-component';
import { BaseTranspilerOptions, Transpiler } from '../../types/transpiler';
import { checkHasState } from '../../helpers/state';
import { addPreventDefault } from './add-prevent-default';
import { convertMethodToFunction } from './convert-method-to-function';
import { renderJSXNodes } from './jsx';
import { arrowFnBlock, File, invoke, SrcBuilder } from './src-generator';
import { runPostJsonPlugins, runPreJsonPlugins } from '../../modules/plugins';
import traverse from 'traverse';

Error.stackTraceLimit = 9999;

// TODO(misko): styles are not processed.

const DEBUG = false;

export interface ToQwikOptions extends BaseTranspilerOptions {}

/**
 * Stores getters and initialization map.
 */
type StateInit = [
  StateValues,
  /**
   * Set of state initializers.
   */
  ...string[],
];

/**
 * Map of getters that need to be rewritten to function invocations.
 */
type StateValues = Record<
  /// property name
  string,
  /// State value
  any
>;

export const componentToQwik =
  (userOptions: ToQwikOptions = {}): Transpiler =>
  ({ component: _component, path }): string => {
    // Make a copy we can safely mutate, similar to babel's toolchain
    let component = fastClone(_component);
    if (userOptions.plugins) {
      component = runPreJsonPlugins(component, userOptions.plugins);
    }
    addPreventDefault(component);
    if (userOptions.plugins) {
      component = runPostJsonPlugins(component, userOptions.plugins);
    }

    const file = new File(
      component.name + '.js',
      {
        isPretty: true,
        isJSX: true,
        isTypeScript: false,
        isModule: true,
        isBuilder: false,
      },
      '@builder.io/qwik',
      '',
    );
    try {
      emitImports(file, component);
      emitTypes(file, component);
      const metadata: Record<string, any> = component.meta.useMetadata || ({} as any);
      const isLightComponent: boolean = metadata?.qwik?.component?.isLight || false;
      const imports: Record<string, string> | undefined = metadata?.qwik?.imports;
      imports && Object.keys(imports).forEach((key) => file.import(imports[key], key));
      const state: StateInit = emitStateMethodsAndRewriteBindings(file, component, metadata);
      let hasState = checkHasState(component);
      let css: string | null = null;
      const componentBody = arrowFnBlock(
        ['props'],
        [
          function (this: SrcBuilder) {
            css = emitUseStyles(file, component);
            emitUseContext(file, component);
            emitUseRef(file, component);
            hasState && emitUseStore(file, state);
            emitUseContextProvider(file, component);
            emitUseMount(file, component);
            emitUseWatch(file, component);
            emitUseCleanup(file, component);
            emitTagNameHack(file, component);
            emitJSX(file, component);
          },
        ],
        [component.propsTypeRef || 'any'],
      );
      file.src.const(
        component.name,
        isLightComponent
          ? componentBody
          : invoke(file.import(file.qwikModule, 'component$'), [componentBody]),
        true,
        true,
      );
      file.exportDefault(component.name);
      emitStyles(file, css);
      DEBUG && file.exportConst('COMPONENT', JSON.stringify(component, null, 2));
      return '// GENERATED BY MITOSIS\n\n' + file.toString();
    } catch (e) {
      console.error(e);
      return (e as Error).stack || String(e);
    }
  };

function emitTagNameHack(file: File, component: MitosisComponent) {
  const elementTag = component.meta.useMetadata?.elementTag as string | undefined;
  if (elementTag) {
    file.src.emit(
      elementTag,
      '=',
      convertMethodToFunction(
        elementTag,
        stateToMethodOrGetter(component.state),
        getLexicalScopeVars(component),
      ),
      ';',
    );
  }
}

function emitUseMount(file: File, component: MitosisComponent) {
  if (component.hooks.onMount) {
    // This is called useMount, but in practice it is used as
    // useClientEffect. Not sure if this is correct, but for now.
    const code = component.hooks.onMount.code;
    file.src.emit(
      file.import(file.qwikModule, 'useClientEffect$').localName,
      '(()=>{',
      code,
      '});',
    );
  }
}
function emitUseWatch(file: File, component: MitosisComponent) {
  if (component.hooks.onUpdate) {
    component.hooks.onUpdate.forEach((onUpdate) => {
      file.src.emit(file.import(file.qwikModule, 'useWatch$').localName, '(({track})=>{');
      emitTrackExpressions(file.src, onUpdate.deps);
      file.src.emit(convertTypeScriptToJS(onUpdate.code));
      file.src.emit('});');
    });
  }
}

function emitTrackExpressions(src: SrcBuilder, deps?: string) {
  if (deps && deps.startsWith('[') && deps.endsWith(']')) {
    const dependencies = deps.substring(1, deps.length - 1).split(',');
    dependencies.forEach((dep) => {
      const lastDotIdx = dep.lastIndexOf('.');
      if (lastDotIdx > 0) {
        const objExp = dep.substring(0, lastDotIdx).replace(/\?$/, '');
        const objProp = dep.substring(lastDotIdx + 1);
        objExp && src.emit(objExp, '&&track(', objExp, ',"', objProp, '");');
      }
    });
  }
}
function emitUseCleanup(file: File, component: MitosisComponent) {
  if (component.hooks.onUnMount) {
    const code = component.hooks.onUnMount.code;
    file.src.emit(file.import(file.qwikModule, 'useCleanup$').localName, '(()=>{', code, '});');
  }
}

function emitJSX(file: File, component: MitosisComponent) {
  const directives = new Map();
  const handlers = new Map<string, string>();
  const styles = new Map();
  const parentSymbolBindings = {};
  file.src.emit(
    'return ',
    renderJSXNodes(file, directives, handlers, component.children, styles, parentSymbolBindings),
  );
}

function emitUseContextProvider(file: File, component: MitosisComponent) {
  Object.keys(component.context.set).forEach((ctxKey) => {
    const context = component.context.set[ctxKey];
    file.src.emit(
      file.import(file.qwikModule, 'useContextProvider').localName,
      '(',
      context.name,
      ',',
      file.import(file.qwikModule, 'useStore').localName,
      '({',
    );
    context.value &&
      Object.keys(context.value).forEach((prop) => {
        const propValue = context.value![prop];
        file.src.emit(prop, ':');
        if (propValue?.type === 'getter') {
          file.src.emit('(()=>{', extractGetterBody(propValue.code), '})(),');
        } else if (typeof propValue == 'function') {
          throw new Error('Qwik: Functions are not supported in context');
        } else {
          file.src.emit(JSON.stringify(propValue));
        }
      });
    file.src.emit('})', ');');
  });
}

function emitUseContext(file: File, component: MitosisComponent) {
  Object.keys(component.context.get).forEach((ctxKey) => {
    const context = component.context.get[ctxKey];
    file.src.emit(
      'const ',
      ctxKey,
      '=',
      file.import(file.qwikModule, 'useContext').localName,
      '(',
      context.name,
      ');',
    );
  });
}

function emitUseRef(file: File, component: MitosisComponent) {
  Object.keys(component.refs).forEach((refKey) => {
    file.src.emit(`const `, refKey, '=', file.import(file.qwikModule, 'useRef').localName, '();');
  });
}

function emitUseStyles(file: File, component: MitosisComponent): string {
  const css = collectCss(component, { prefix: component.name });
  if (css) {
    file.src.emit(file.import(file.qwikModule, 'useStylesScoped$').localName, '(STYLES);');
  }
  return css;
}

function emitStyles(file: File, css: string | null) {
  if (css) {
    file.exportConst('STYLES', '`' + css.replace(/`/g, '\\`') + '`');
  }
}

/**
 * @param file
 * @param stateInit
 */
function emitUseStore(file: File, stateInit: StateInit) {
  const state = stateInit[0];
  const hasState = state && Object.keys(state).length > 0;
  if (hasState) {
    file.src.emit('const state=', file.import(file.qwikModule, 'useStore').localName, '(');
    file.src.emit(JSON.stringify(state));
    file.src.emit(');');
  } else {
    // TODO hack for now so that `state` variable is defined, even though it is never read.
    file.src.emit('const state={};');
  }
}

function emitTypes(file: File, component: MitosisComponent) {
  if (file.options.isTypeScript) {
    component.types?.forEach((t) => file.src.emit(t, '\n'));
  }
}

function emitStateMethodsAndRewriteBindings(
  file: File,
  component: MitosisComponent,
  metadata: Record<string, any>,
): StateInit {
  const lexicalArgs = getLexicalScopeVars(component);
  const state: StateInit = emitStateMethods(file, component.state, lexicalArgs);
  const methodMap = stateToMethodOrGetter(component.state);
  rewriteCodeExpr(component, methodMap, lexicalArgs, metadata.qwik?.replace);
  return state;
}

const checkIsObjectWithCodeBlock = (obj: any): obj is { code: string } => {
  return typeof obj == 'object' && obj?.code && typeof obj.code === 'string';
};

function rewriteCodeExpr(
  component: MitosisComponent,
  methodMap: Record<string, 'method' | 'getter'>,
  lexicalArgs: string[],
  replace: Record<string, string> | undefined = {},
) {
  traverse(component).forEach(function (item) {
    if (!(checkIsCodeValue(item) || checkIsObjectWithCodeBlock(item))) {
      return;
    }

    let code = convertMethodToFunction(item.code, methodMap, lexicalArgs);

    Object.keys(replace).forEach((key) => {
      code = code.replace(key, replace[key]);
    });

    item.code = code;
  });
}

function getLexicalScopeVars(component: MitosisComponent) {
  return ['props', 'state', ...Object.keys(component.refs), ...Object.keys(component.context.get)];
}

function emitImports(file: File, component: MitosisComponent) {
  // <SELF> is used for self-referencing within the file.
  file.import('<SELF>', component.name);
  component.imports?.forEach((i) => {
    Object.keys(i.imports).forEach((key) => {
      const keyValue = i.imports[key]!;
      file.import(i.path.replace('.lite', '').replace('.tsx', ''), keyValue, key);
    });
  });
}

function emitStateMethods(
  file: File,
  componentState: MitosisComponent['state'],
  lexicalArgs: string[],
): StateInit {
  const stateValues: StateValues = {};
  const stateInit: StateInit = [stateValues];
  const methodMap = stateToMethodOrGetter(componentState);
  Object.keys(componentState).forEach((key) => {
    const stateValue = componentState[key];
    if (checkIsCodeValue(stateValue)) {
      let code = stateValue.code;
      let prefixIdx = 0;
      if (stateValue.type === 'getter') {
        prefixIdx += 'get '.length;
      } else if (stateValue.type === 'function') {
        prefixIdx += 'function '.length;
      }
      code = code.substring(prefixIdx);
      code = convertMethodToFunction(code, methodMap, lexicalArgs).replace(
        '(',
        `(${lexicalArgs.join(',')},`,
      );
      const functionName = code.split(/\(/)[0];
      if (stateValue.type === 'getter') {
        stateInit.push(`state.${key}=${functionName}(${lexicalArgs.join(',')})`);
      }
      if (!file.options.isTypeScript) {
        // Erase type information
        code = convertTypeScriptToJS(code);
      }
      file.exportConst(functionName, 'function ' + code, true);
    } else {
      stateValues[key] = stateValue?.code;
    }
  });
  return stateInit;
}

function convertTypeScriptToJS(code: string): string {
  return babelTransformExpression(code, {});
}

function extractGetterBody(code: string): string {
  const start = code.indexOf('{');
  const end = code.lastIndexOf('}');
  return code.substring(start + 1, end).trim();
}

function stateToMethodOrGetter(
  state: MitosisComponent['state'],
): Record<string, 'method' | 'getter'> {
  const methodMap: Record<string, 'method' | 'getter'> = {};
  Object.keys(state).forEach((key) => {
    const stateVal = state[key];
    if (stateVal?.type === 'getter' || stateVal?.type === 'method') {
      methodMap[key] = stateVal.type;
    }
  });
  return methodMap;
}
