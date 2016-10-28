/* @flow */
import traverse from 'babel-traverse';
import * as t from 'babel-types';

import typeAnnotationIterator from './typeAnnotationIterator';
import ConversionContext from './ConversionContext';
import convert from './convert';

import firstPassVisitors from './firstPassVisitors';
import getTypeParameters from './getTypeParameters';
import {ok as invariant} from 'assert';
import type {Node, NodePath} from 'babel-traverse';

export default function transform (input: Node): Node {
  const context = new ConversionContext();

  traverse(input, firstPassVisitors(context));

  traverse(input, {
    Program (path: NodePath) {
      attachImport(context, path);
    },
    ImportDeclaration: {
      exit (path: NodePath) {
        if (path.node.importKind !== 'type') {
          return;
        }
        path.node.importKind = 'value';
      }
    },
    ExportDeclaration: {
      exit (path: NodePath) {
        if (path.node.exportKind !== 'type') {
          return;
        }
        path.node.exportKind = 'value';
      }
    },
    TypeAlias (path: NodePath) {
      const replacement = convert(context, path);
      path.replaceWith(replacement);
    },
    TypeCastExpression (path: NodePath) {
      const expression = path.get('expression');
      const typeAnnotation = path.get('typeAnnotation');
      if (!expression.isIdentifier()) {
        path.replaceWith(t.callExpression(
          t.memberExpression(
            convert(context, typeAnnotation),
            t.identifier('assert')
          ),
          [expression.node]
        ));
        return;
      }
      const name = expression.node.name;
      const binding = path.scope.getBinding(name);
      if (binding && binding.path.isCatchClause()) {
        // special case typecasts for error handlers.
        path.parentPath.replaceWith(t.ifStatement(
          t.unaryExpression('!', t.callExpression(
            t.memberExpression(
              convert(context, typeAnnotation),
              t.identifier('match')
            ),
            [expression.node]
          )),
          t.blockStatement([t.throwStatement(expression.node)])
        ));
        return;
      }

      let valueUid = path.scope.getData(`valueUid:${name}`);

      if (!valueUid) {
        valueUid = path.scope.generateUidIdentifier(`${name}Type`);
        path.scope.setData(`valueUid:${name}`, valueUid);
        path.insertBefore(t.variableDeclaration('let', [
          t.variableDeclarator(
            valueUid,
            convert(context, typeAnnotation)
          )
        ]));
      }
      else {
        path.insertBefore(t.expressionStatement(
          t.assignmentExpression(
            '=',
            valueUid,
            convert(context, typeAnnotation)
          )
        ));
      }
      path.replaceWith(t.callExpression(
        t.memberExpression(
          valueUid,
          t.identifier('assert')
        ),
        [expression.node]
      ));
    },
    VariableDeclarator (path: NodePath) {
      const id = path.get('id');
      const {name} = id.node;

      if (!id.has('typeAnnotation')) {
        return;
      }
      if (!path.has('init') || path.parentPath.node.kind !== 'const') {
        const valueUid = path.scope.generateUidIdentifier(`${name}Type`);
        path.scope.setData(`valueUid:${name}`, valueUid);
        path.insertBefore(t.variableDeclarator(
          valueUid,
          convert(context, id.get('typeAnnotation'))
        ));
        if (path.has('init')) {
          const wrapped = t.callExpression(
            t.memberExpression(
              valueUid,
              t.identifier('assert')
            ),
            [path.get('init').node]
          );
          path.replaceWith(t.variableDeclarator(
            t.identifier(name),
            wrapped
          ));
        }
        else {
          path.replaceWith(t.variableDeclarator(
            t.identifier(name)
          ));
        }
      }
      else {
        const wrapped = t.callExpression(
          t.memberExpression(
            convert(context, id.get('typeAnnotation')),
            t.identifier('assert')
          ),
          [path.get('init').node]
        );
        path.replaceWith(t.variableDeclarator(
          t.identifier(name),
          wrapped
        ));
      }
    },
    AssignmentExpression (path: NodePath) {
      const left = path.get('left');
      if (!left.isIdentifier()) {
        return;
      }
      const name = left.node.name;
      const valueUid = path.scope.getData(`valueUid:${name}`);
      if (!valueUid) {
        return;
      }
      const right = path.get('right');
      right.replaceWith(t.callExpression(
        t.memberExpression(
          valueUid,
          t.identifier('assert')
        ),
        [right.node]
      ));
    },
    Function (path: NodePath) {
      const body = path.get('body');

      const definitions = [];
      const invocations = [];
      const typeParameters = getTypeParameters(path);
      const params = path.get('params');

      for (const typeParameter of typeParameters) {
        const {name} = typeParameter.node;
        const args = [t.stringLiteral(name)];
        if (typeParameter.has('bound')) {
          args.push(
            convert(context, typeParameter.get('bound'))
          );
        }
        definitions.push(t.variableDeclaration('const', [
          t.variableDeclarator(
            t.identifier(name),
            context.call('typeParameter', ...args)
          )
        ]));
      }

      let shouldShadow = false;

      for (let param of params) {
        const argumentIndex = +param.key;
        let assignmentRight;
        if (param.isAssignmentPattern()) {
          assignmentRight = param.get('right');
          param = param.get('left');
        }
        if (!param.has('typeAnnotation')) {
          continue;
        }
        const typeAnnotation = param.get('typeAnnotation');

        if (param.isObjectPattern() || param.isArrayPattern()) {
          shouldShadow = true;

          const args = [
            t.stringLiteral(`arguments[${argumentIndex}]`),
            convert(context, typeAnnotation)
          ];
          if (param.has('optional')) {
            args.push(t.booleanLiteral(true));
          }

          const ref = t.memberExpression(
            t.identifier('arguments'),
            t.numericLiteral(argumentIndex),
            true
          );

          const expression = t.expressionStatement(
            t.callExpression(
              t.memberExpression(context.call('param', ...args), t.identifier('assert')),
              [ref]
            )
          );
          if (assignmentRight) {
            invocations.push(
              t.ifStatement(
                t.binaryExpression(
                  '!==',
                  ref,
                  t.identifier('undefined')
                ),
                t.blockStatement([expression])
              )
            );
          }
          else {
            invocations.push(expression);
          }
        }
        else {
          let name = param.node.name;
          let methodName = 'param';
          if (param.isRestElement()) {
            methodName = 'rest';
            name = param.node.argument.name;
          }
          else if (!param.isIdentifier()) {
            continue;
          }
          const valueUid = body.scope.generateUidIdentifier(`${name}Type`);
          body.scope.setData(`valueUid:${name}`, valueUid);
          definitions.push(t.variableDeclaration('let', [
            t.variableDeclarator(
              valueUid,
              convert(context, typeAnnotation)
            )
          ]));
          const args = [t.stringLiteral(name), valueUid];
          if (param.has('optional')) {
            args.push(t.booleanLiteral(true));
          }
          invocations.push(t.expressionStatement(
            t.callExpression(
              t.memberExpression(context.call(methodName, ...args), t.identifier('assert')),
              [t.identifier(name)]
            )
          ));
        }



      }

      if (path.has('returnType')) {
        let returnType = path.get('returnType');
        if (returnType.type === 'TypeAnnotation') {
          returnType = returnType.get('typeAnnotation');
        }
        const returnTypeParameters = getTypeParameters(returnType);
        if (returnType.isGenericTypeAnnotation() && returnTypeParameters.length > 0) {
          // If we're in an async function, make the return type the promise resolution type.
          if (path.node.async) {
            // @todo warn if identifier is not Promise ?
            returnType = getTypeParameters(returnType)[0];
          }
          else if (path.node.generator) {
            const yieldType = returnTypeParameters[0];
            returnType  = returnTypeParameters[1];
            const nextType = returnTypeParameters[2];
            const yieldTypeUid = body.scope.generateUidIdentifier('yieldType');
            body.scope.setData(`yieldTypeUid`, yieldTypeUid);
            definitions.push(t.variableDeclaration('const', [
              t.variableDeclarator(
                yieldTypeUid,
                convert(context, yieldType)
              )
            ]));
            const nextTypeUid = body.scope.generateUidIdentifier('nextType');
            body.scope.setData(`nextTypeUid`, nextTypeUid);
            definitions.push(t.variableDeclaration('const', [
              t.variableDeclarator(
                nextTypeUid,
                convert(context, nextType)
              )
            ]));
          }
        }
        const returnTypeUid = body.scope.generateUidIdentifier('returnType');
        body.scope.setData(`returnTypeUid`, returnTypeUid);
        definitions.push(t.variableDeclaration('const', [
          t.variableDeclarator(
            returnTypeUid,
            context.call('return', convert(context, returnType))
          )
        ]));
      }
      if (shouldShadow && path.isArrowFunctionExpression()) {
        path.arrowFunctionToShadowed();
        path.get('body').unshiftContainer('body', definitions.concat(invocations));
      }
      else {
        body.unshiftContainer('body', definitions.concat(invocations));
      }

    },

    ReturnStatement (path: NodePath) {
      const fn = path.scope.getFunctionParent().path;
      if (!fn.has('returnType')) {
        return;
      }
      const returnTypeUid = path.scope.getData('returnTypeUid');

      const argument = path.get('argument');
      argument.replaceWith(t.callExpression(
        t.memberExpression(returnTypeUid, t.identifier('assert')),
        argument.node ? [argument.node] : []
      ));
    },

    YieldExpression (path: NodePath) {
      const fn = path.scope.getFunctionParent().path;
      if (!fn.has('returnType')) {
        return;
      }
      if (context.visited.has(path.node)) {
        return;
      }
      const yieldTypeUid = path.scope.getData('yieldTypeUid');
      const nextTypeUid = path.scope.getData('nextTypeUid');

      const argument = path.get('argument');
      let replacement;
      if (path.node.delegate) {
        replacement = t.yieldExpression(
          t.callExpression(
            context.call('wrapIterator', yieldTypeUid),
            argument.node ? [argument.node] : []
          ),
          true
        );
      }
      else {
        replacement = t.yieldExpression(
          t.callExpression(
            t.memberExpression(yieldTypeUid, t.identifier('assert')),
            argument.node ? [argument.node] : []
          )
        );
      }

      context.visited.add(replacement);
      if (path.parentPath.isExpressionStatement()) {
        path.replaceWith(replacement);
      }
      else {
        path.replaceWith(t.callExpression(
          t.memberExpression(nextTypeUid, t.identifier('assert')),
          [replacement]
        ));
      }
    },

    Class: {
      exit (path: NodePath) {
        const typeParameters = getTypeParameters(path);
        const superTypeParameters
            = path.has('superTypeParameters')
            ? path.get('superTypeParameters.params')
            : []
            ;
        const hasTypeParameters = typeParameters.length > 0;
        const hasSuperTypeParameters = superTypeParameters.length > 0;
        if (!hasTypeParameters && !hasSuperTypeParameters) {
          // Nothing to do here.
          return;
        }
        const [constructor] = path.get('body.body').filter(
          item => item.node.kind === 'constructor'
        );
        if (path.has('superClass')) {
          const body = constructor.get('body');
          const typeParametersUid = t.identifier(path.scope.getData('typeParametersUid'));

          const trailer = [];
          if (hasTypeParameters) {
            body.unshiftContainer('body', t.variableDeclaration(
              'const',
              [t.variableDeclarator(
                typeParametersUid,
                t.objectExpression(typeParameters.map(typeParameter => {
                  return t.objectProperty(
                    t.identifier(typeParameter.node.name),
                    convert(context, typeParameter)
                  );
                }))
              )]
            ));

            const thisTypeParameters = t.memberExpression(
              t.thisExpression(),
              context.symbol('TypeParameters'),
              true
            );

            trailer.push(
              t.ifStatement(
                thisTypeParameters,
                t.blockStatement([
                  t.expressionStatement(
                    t.callExpression(
                      t.memberExpression(
                        t.identifier('Object'),
                        t.identifier('assign')
                      ),
                      [thisTypeParameters, typeParametersUid]
                    )
                  )
                ]),
                t.blockStatement([
                  t.expressionStatement(
                    t.assignmentExpression(
                      '=',
                      thisTypeParameters,
                      typeParametersUid
                    )
                  )
                ])
              )
            );
          }

          if (hasSuperTypeParameters) {
            trailer.push(t.expressionStatement(
              context.call(
                'bindTypeParameters',
                t.thisExpression(),
                ...superTypeParameters.map(item => convert(context, item))
              )
            ));
          }
          getSuperStatement(body).insertAfter(trailer);
        }
        else {
          constructor.get('body').unshiftContainer('body', t.expressionStatement(
            t.assignmentExpression(
              '=',
              t.memberExpression(
                t.thisExpression(),
                context.symbol('TypeParameters'),
                true
              ),
              t.objectExpression(typeParameters.map(typeParameter => {
                return t.objectProperty(
                  t.identifier(typeParameter.node.name),
                  convert(context, typeParameter)
                );
              }))
            )
          ));
        }

      }
    },

    ClassProperty (path: NodePath) {
      if (!path.has('typeAnnotation')) {
        return;
      }
      const typeAnnotation = path.get('typeAnnotation');
      let decorator;
      if (annotationReferencesClassEntity (context, typeAnnotation)) {
        decorator = t.decorator(context.call(
          'decorate',
          t.functionExpression(
            null,
            [],
            t.blockStatement([
              t.returnStatement(convert(context, typeAnnotation))
            ])
          )
        ));
      }
      else {
        decorator = t.decorator(context.call('decorate', convert(context, typeAnnotation)));
      }
      if (!path.has('decorators')) {
        path.node.decorators = [];
      }
      path.pushContainer('decorators', decorator);
    }
  });
  return input;
}

function attachImport (context: ConversionContext, container: NodePath) {
  for (const item of container.get('body')) {
    if (item.type === 'Directive') {
      continue;
    }
    const importDeclaration = t.importDeclaration(
      [t.importDefaultSpecifier(t.identifier(context.libraryId))],
      t.stringLiteral(context.libraryName)
    );
    item.insertBefore(importDeclaration);
    return;
  }
}


function annotationReferencesClassEntity (context: ConversionContext, annotation: NodePath): boolean {
  for (const item of typeAnnotationIterator(annotation)) {
    if (item.type !== 'Identifier') {
      continue;
    }
    const entity = context.getEntity(item.node.name, annotation);
    if (entity && entity.isClassTypeParameter) {
      return true;
    }
    else if (entity && entity.isValue && !entity.isGlobal) {
      return true;
    }

  }
  return false;
}

function getSuperStatement (block: NodePath): NodePath {
  let found;
  block.traverse({
    Super (path: NodePath) {
      found = path.getStatementParent();
    }
  });
  invariant(found, "Constructor of sub class must contain super().");
  return found;
}